/* Provides a single endpoint for all services. */
import { RequestHandler } from "express";
import { generateErrorMessage } from "zod-error";
import { APIFormat } from "../shared/key-management";
import {
  getServiceForModel,
  LLMService,
  MODEL_FAMILIES,
  MODEL_FAMILY_SERVICE,
  ModelFamily,
} from "../shared/models";
import { API_SCHEMA_VALIDATORS } from "../shared/api-schemas";

const detectApiFormat = (body: any, formats: APIFormat[]): APIFormat => {
  const errors = [];
  for (const format of formats) {
    const result = API_SCHEMA_VALIDATORS[format].safeParse(body);
    if (result.success) {
      return format;
    } else {
      errors.push(result.error);
    }
  }
  throw new Error(`Couldn't determine the format of your request. Errors: ${errors}`);
};

/**
 * Tries to infer LLMService and APIFormat using the model name and the presence
 * of certain fields in the request body.
 */
const inferService: RequestHandler = (req, res, next) => {
  const model = req.body.model;
  if (!model) {
    throw new Error("No model specified");
  }

  // Service determines the key provider and is typically determined by the
  // requested model, though some models are served by multiple services.
  // API format determines the expected request/response format.
  let service: LLMService;
  let inboundApi: APIFormat;
  let outboundApi: APIFormat;

  if (MODEL_FAMILIES.includes(model)) {
    service = MODEL_FAMILY_SERVICE[model as ModelFamily];
  } else {
    service = getServiceForModel(model);
  }

  // Each service has typically one API format.
  switch (service) {
    case "openai": {
      const detected = detectApiFormat(req.body, ["openai", "openai-text", "openai-image"]);

    }

  }
};
