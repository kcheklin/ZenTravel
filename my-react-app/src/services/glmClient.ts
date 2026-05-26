// ILMU API — OpenAI-compatible format
// Base URL: https://api.ilmu.ai/v1
// Model: ilmu-glm-5.1

interface ILMUMessage {
  content?:           string | null;
  reasoning_content?: string | null; // GLM-5.1 thinking model: COT goes here
}

interface ILMUResponse {
  choices?: Array<{ message?: ILMUMessage; finish_reason?: string }>;
  error?:   { message?: string };
}

// Supports both plain text and multimodal (vision) content blocks
export type MessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

const isDev = import.meta.env.DEV;
const ILMU_API_BASE =
  import.meta.env.VITE_GLM_API_URL ?? (isDev ? '/ilmu-api/v1' : 'https://api.ilmu.ai/v1');
const ILMU_MODEL   = import.meta.env.VITE_GLM_MODEL ?? 'ilmu-glm-5.1';

// ilmu-glm-5.1 is a "thinking" model: it spends completion tokens on internal
// chain-of-thought before writing the answer.  Each call needs a generous token
// budget so the model can finish reasoning AND produce visible output.
// Rule of thumb: target_output_tokens × 4 ≈ safe max_tokens value.
// ilmu-glm-5.1 generates ~40 tokens/s. Larger max_tokens + thinking can exceed 40s.
const CLIENT_TIMEOUT_MS = 90_000;
/** Thinking models may consume the entire completion budget in internal reasoning; floor avoids trivially short caps. */
const THINKING_MODEL_MIN_MAX_TOKENS = 1024;
const MAX_RETRIES = 2;

export class GLMClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async complete(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: MessageContent }>,
    maxTokens = THINKING_MODEL_MIN_MAX_TOKENS,
  ): Promise<string> {
    let lastErr: Error = new Error('Unknown error');
    let tokenBudget = Math.max(maxTokens, THINKING_MODEL_MIN_MAX_TOKENS);
    
    // exponential backoff retry loop
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Shorter retry delay (800ms, 1600ms...)
        await new Promise((r) => setTimeout(r, 800 * attempt)); 
      }

      //extend timeout for each retry
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

      try {
        const response = await fetch(`${ILMU_API_BASE}/chat/completions`, {
          method:  'POST',
          signal:  controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model:       ILMU_MODEL,
            messages,
            temperature: 0,      // 0 = least exploratory thinking, fastest output
            max_tokens:  tokenBudget,
          }),
        });

        clearTimeout(timer);

        // Retry on 5xx (includes 504 Gateway Timeout)
        if (response.status >= 500) {
          lastErr = new Error(`ILMU ${response.status} — server error, retrying...`);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`ILMU request failed (${response.status}): ${text}`);
        }

        const data = (await response.json()) as ILMUResponse;

        if (data.error?.message) {
          throw new Error(`ILMU API error: ${data.error.message}`);
        }

        const choice = data.choices?.[0];
        const msg = choice?.message;
        const finishReason = choice?.finish_reason;

        // GLM-5.1 is a thinking model: the visible reply is in `content` but
        // when the model "thinks" heavily, `content` may be null/empty while
        // all tokens go into `reasoning_content`.  Fall back gracefully.
        const content =
          msg?.content?.trim() ||
          msg?.reasoning_content?.trim() ||
          '';

        if (!content) {
          // Entire completion budget spent on internal reasoning — no `content` yet
          if (finishReason === 'length' && attempt < MAX_RETRIES) {
            const next = Math.min(Math.max(tokenBudget * 2, THINKING_MODEL_MIN_MAX_TOKENS * 2), 8192);
            console.warn(
              `[GLMClient] finish_reason=length with empty content; retrying with max_tokens ${tokenBudget} → ${next}`,
            );
            tokenBudget = next;
            lastErr = new Error('ILMU hit max_tokens before visible output; retrying with larger budget.');
            continue;
          }
          console.warn('[GLMClient] Empty response body:', JSON.stringify(data).slice(0, 300));
          lastErr = new Error('ILMU returned an empty response. Please try again.');
          continue;
        }

        return content;

      } catch (err) {
        clearTimeout(timer);
        
        if (err instanceof DOMException && err.name === 'AbortError') {
          lastErr = new Error(`GLM request timed out after ${CLIENT_TIMEOUT_MS / 1000}s`);
          continue;
        }
        
        // Network errors are also retryable
        if (err instanceof TypeError) {
          lastErr = err;
          continue;
        }
        
        throw err; // non-retryable (auth, bad request, etc.)
      }
    }

    // If we get here, it means all retries failed
    throw lastErr; // preserve the stack trace & prevent fail silently
  }
}

export function createGLMClientFromEnv(): GLMClient | null {
  const apiKey = import.meta.env.VITE_GLM_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return null;
  }
  return new GLMClient(apiKey.trim());
}