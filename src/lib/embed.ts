// Query embedding in the browser via transformers.js.
// Lazily loads the quantized all-MiniLM-L6-v2 model the first time it's needed,
// so the page itself stays light until the user runs a semantic search.

import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/** Kick off (or reuse) loading the embedding model. */
export function loadModel(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline(
      "feature-extraction",
      MODEL_ID,
    ) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

/** Whether the model has begun loading (for UI state). */
export function isModelLoading(): boolean {
  return extractorPromise !== null;
}

/**
 * Embed a query string and return a normalized Float32Array (unit length),
 * so a plain dot product against the (also-normalized) corpus vectors = cosine.
 *
 * Note: we apply mean pooling + L2 normalize, matching how the corpus was
 * embedded with sentence-transformers all-MiniLM-L6-v2.
 */
export async function embedQuery(query: string): Promise<Float32Array> {
  const extractor = await loadModel();
  const output = await extractor(query, {
    pooling: "mean",
    normalize: true, // transformers.js L2-normalizes for us
  });
  // output.data is a Float32Array of length `dims`
  return output.data as Float32Array;
}
