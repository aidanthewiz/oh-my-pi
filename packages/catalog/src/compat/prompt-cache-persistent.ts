import type { Model } from "../types";
import { isCatalogEndpointUrl } from "./catalog-endpoint";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Whether catalog policy declares persistent prompt caching on this model's
 * first-party HTTPS host. This metadata exempts idle compaction only; it
 * establishes neither a warm cache nor credential validity or request admission.
 */
export function isPromptCachePersistent(model: Model): boolean {
	return resolveCatalogPolicy(model).promptCachePersistent === true && isCatalogEndpointUrl(model, model.baseUrl);
}
