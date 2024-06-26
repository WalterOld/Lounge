import { Request, RequestHandler, Response, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { v4 } from "uuid";
import { config } from "../config";
import { logger } from "../logger";
import { createQueueMiddleware } from "./queue";
import { ipLimiter } from "./rate-limit";
import { handleProxyError } from "./middleware/common";
import {
  createPreprocessorMiddleware,
  signAwsRequest,
  finalizeSignedRequest,
  createOnProxyReqHandler,
} from "./middleware/request";
import {
  ProxyResHandlerWithBody,
  createOnProxyResHandler,
} from "./middleware/response";
import { transformAnthropicChatResponseToAnthropicText, transformAnthropicChatResponseToOpenAI } from "./anthropic";
import { sendErrorToClient } from "./middleware/response/error-generator";

const LATEST_AWS_V2_MINOR_VERSION = "1";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.awsCredentials) return { object: "list", data: [] };

  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html
  const variants = [
    "anthropic.claude-v2",
    "anthropic.claude-v2:1",
    "anthropic.claude-3-haiku-20240307-v1:0",
    "anthropic.claude-3-sonnet-20240229-v1:0",
    "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "anthropic.claude-3-opus-20240229-v1:0",
  ];

  const models = variants.map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: "anthropic",
    permission: [],
    root: "claude",
    parent: null,
  }));

  modelsCache = { object: "list", data: models };
  modelsCacheTime = new Date().getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

/** Only used for non-streaming requests. */
const awsResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  switch (`${req.inboundApi}<-${req.outboundApi}`) {
    case "openai<-anthropic-text":
      req.log.info("Transforming Anthropic Text back to OpenAI format");
      newBody = transformAwsTextResponseToOpenAI(body, req);
      break;
    case "openai<-anthropic-chat":
      req.log.info("Transforming AWS Anthropic Chat back to OpenAI format");
      newBody = transformAnthropicChatResponseToOpenAI(body);
      break;
    case "anthropic-text<-anthropic-chat":
      req.log.info("Transforming AWS Anthropic Chat back to Text format");
      newBody = transformAnthropicChatResponseToAnthropicText(body);
      break;
  }

  // AWS does not always confirm the model in the response, so we have to add it
  if (!newBody.model && req.body.model) {
    newBody.model = req.body.model;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

/**
 * Transforms a model response from the Anthropic API to match those from the
 * OpenAI API, for users using Claude via the OpenAI-compatible endpoint. This
 * is only used for non-streaming requests as streaming requests are handled
 * on-the-fly.
 */
function transformAwsTextResponseToOpenAI(
  awsBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "aws-" + v4(),
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: awsBody.completion?.trim(),
        },
        finish_reason: awsBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const awsProxy = createQueueMiddleware({
  beforeProxy: signAwsRequest,
  proxyMiddleware: createProxyMiddleware({
    target: "bad-target-will-be-rewritten",
    router: ({ signedRequest }) => {
      if (!signedRequest) throw new Error("Must sign request before proxying");
      return `${signedRequest.protocol}//${signedRequest.hostname}`;
    },
    changeOrigin: true,
    selfHandleResponse: true,
    logger,
    on: {
      proxyReq: createOnProxyReqHandler({ pipeline: [finalizeSignedRequest] }),
      proxyRes: createOnProxyResHandler([awsResponseHandler]),
      error: handleProxyError,
    },
  }),
});

const nativeTextPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-text", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

const textToChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-chat", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes text completion prompts to aws anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const preprocessAwsTextRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.includes("claude-3")) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const oaiToAwsTextPreprocessor = createPreprocessorMiddleware(
  { inApi: "openai", outApi: "anthropic-text", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

const oaiToAwsChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "openai", outApi: "anthropic-chat", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes an OpenAI prompt to either the legacy Claude text completion endpoint
 * or the new Claude chat completion endpoint, based on the requested model.
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.includes("claude-3")) {
    oaiToAwsChatPreprocessor(req, res, next);
  } else {
    oaiToAwsTextPreprocessor(req, res, next);
  }
};

const awsRouter = Router();
awsRouter.get("/v1/models", handleModelRequest);
// Native(ish) Anthropic text completion endpoint.
awsRouter.post("/v1/complete", ipLimiter, preprocessAwsTextRequest, awsProxy);
// Native Anthropic chat completion endpoint.
awsRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic-chat", outApi: "anthropic-chat", service: "aws" },
    { afterTransform: [maybeReassignModel] }
  ),
  awsProxy
);
// Temporary force-Claude3 endpoint
awsRouter.post(
  "/v1/sonnet/:action(complete|messages)",
  ipLimiter,
  handleCompatibilityRequest,
  createPreprocessorMiddleware({
    inApi: "anthropic-text",
    outApi: "anthropic-chat",
    service: "aws",
  }),
  awsProxy
);

// OpenAI-to-AWS Anthropic compatibility endpoint.
awsRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  awsProxy
);

/**
 * Tries to deal with:
 * - frontends sending AWS model names even when they want to use the OpenAI-
 *   compatible endpoint
 * - frontends sending Anthropic model names that AWS doesn't recognize
 * - frontends sending OpenAI model names because they expect the proxy to
 *   translate them
 * 
 * If client sends AWS model ID it will be used verbatim. Otherwise, various
 * strategies are used to try to map a non-AWS model name to AWS model ID.
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;

  // If it looks like an AWS model, use it as-is
  if (model.includes("anthropic.claude")) {
    return;
  }

  // Anthropic model names can look like:
  // - claude-v1
  // - claude-2.1
  // - claude-3-5-sonnet-20240620-v1:0
  const pattern =
    /^(claude-)?(instant-)?(v)?(\d+)([.-](\d{1}))?(-\d+k)?(-sonnet-|-opus-|-haiku-)?(\d*)/i;
  const match = model.match(pattern);

  // If there's no match, fallback to Claude v2 as it is most likely to be
  // available on AWS.
  if (!match) {
    req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
    return;
  }

  const [_, _cl, instant, _v, major, _sep, minor, _ctx, name, _rev] = match;

  if (instant) {
    req.body.model = "anthropic.claude-instant-v1";
    return;
  }
  
  const ver = minor ? `${major}.${minor}` : major;
  switch (ver) {
    case "1":
    case "1.0":
      req.body.model = "anthropic.claude-v1";
      return;
    case "2":
    case "2.0":
      req.body.model = "anthropic.claude-v2";
      return;
    case "3":
    case "3.0":
      if (name.includes("opus")) {
        req.body.model = "anthropic.claude-3-opus-20240229-v1:0";
      } else if (name.includes("haiku")) {
        req.body.model = "anthropic.claude-3-haiku-20240307-v1:0";
      } else {
        req.body.model = "anthropic.claude-3-sonnet-20240229-v1:0";
      }
      return;
    case "3.5":
      req.body.model = "anthropic.claude-3-5-sonnet-20240620-v1:0";
      return;
  }

  // Fallback to Claude 2.1
  req.body.model = `anthropic.claude-v2:${LATEST_AWS_V2_MINOR_VERSION}`;
  return;
}

export function handleCompatibilityRequest(
  req: Request,
  res: Response,
  next: any
) {
  const action = req.params.action;
  const alreadyInChatFormat = Boolean(req.body.messages);
  const compatModel = "anthropic.claude-3-5-sonnet-20240620-v1:0";
  req.log.info(
    { inputModel: req.body.model, compatModel, alreadyInChatFormat },
    "Handling AWS compatibility request"
  );

  if (action === "messages" || alreadyInChatFormat) {
    return sendErrorToClient({
      req,
      res,
      options: {
        title: "Unnecessary usage of compatibility endpoint",
        message: `Your client seems to already support the new Claude API format. This endpoint is intended for clients that do not yet support the new format.\nUse the normal \`/aws/claude\` proxy endpoint instead.`,
        format: "unknown",
        statusCode: 400,
        reqId: req.id,
        obj: {
          requested_endpoint: "/aws/claude/sonnet",
          correct_endpoint: "/aws/claude",
        },
      },
    });
  }

  req.body.model = compatModel;
  next();
}

export const aws = awsRouter;
