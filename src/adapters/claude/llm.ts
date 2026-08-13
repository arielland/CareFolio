import Anthropic from '@anthropic-ai/sdk';
import type { AnyContext } from '@/core/context/space-context';
import {
  PDF_TYPE,
  SUPPORTED_IMAGE_TYPES,
  type ExtractionRequest,
  type LlmPort,
  type LlmResult,
  type ScanFile,
  type SupportedImageType,
  type TextExtractionRequest,
} from '@/core/ports/llm';
import { log, type LogFields } from '@/core/logging/logger';
import { flushLogs } from '@/core/logging/persist';

/**
 * Claude behind LlmPort (DESIGN.md §10).
 *
 * The one rule this adapter exists to enforce: it logs call *metadata* — model, tokens,
 * latency — and never the prompt or the completion. Both sides of an extraction call
 * are health content (DESIGN.md §7.1).
 */

const MODEL = 'claude-opus-5';

export class ClaudeAdapter implements LlmPort {
  private client: Anthropic | undefined;

  /**
   * Logs a completed call, and waits until that line is durable.
   *
   * The waiting is the point. Every other log line in this app can be dropped on the floor
   * without anyone being worse off; this one is the only record that money was spent, and
   * the usage screen is a `select` over exactly these rows. A serverless instance can be
   * frozen the instant a response is sent, so a fire-and-forget insert issued here would
   * be lost precisely on the requests that cost the most.
   *
   * It costs one round trip on a path that has just spent tens of seconds inside a model.
   */
  private static async record(event: string, fields: LogFields): Promise<void> {
    log.info(event, { module: 'adapters/claude', provider: 'anthropic', outcome: 'success', ...fields });
    await flushLogs();
  }

  private sdk(): Anthropic {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set — document extraction is unavailable.');
    }
    this.client ??= new Anthropic();
    return this.client;
  }

  /**
   * PDFs go as `document` blocks and images as `image` blocks. Claude reads PDFs
   * natively — multi-page scans need no rasterization on our side, which is why this
   * is a branch rather than a conversion pipeline.
   */
  private static contentBlock(file: ScanFile): Anthropic.ContentBlockParam {
    const data = Buffer.from(file.data).toString('base64');

    if (file.mimeType === PDF_TYPE) {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    }

    if (!SUPPORTED_IMAGE_TYPES.includes(file.mimeType as SupportedImageType)) {
      throw new Error(`Unsupported document type: ${file.mimeType}`);
    }

    return {
      type: 'image',
      source: { type: 'base64', media_type: file.mimeType as SupportedImageType, data },
    };
  }

  async extractFromDocument<T>(ctx: AnyContext, request: ExtractionRequest): Promise<LlmResult<T>> {
    const startedAt = performance.now();

    // A tool with a strict schema is how the model is made to return exactly the fields
    // the documents module declared, rather than prose we'd have to parse.
    const response = await this.sdk().messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [
        {
          name: 'record_document',
          description: 'Record the fields extracted from the medical document.',
          input_schema: request.schema as Anthropic.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: 'record_document' },
      messages: [
        {
          role: 'user',
          // The document precedes the instructions: the model reads the attachment
          // first, then what to do with it. Multi-page documents send every page in this
          // one message, in order, so fields can be drawn from across the whole document.
          content: [
            ...request.files.map((file) => ClaudeAdapter.contentBlock(file)),
            { type: 'text', text: request.instructions },
          ],
        },
      ],
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Extraction returned no structured result.');
    }

    const usage = {
      model: MODEL,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };

    await ClaudeAdapter.record('llm.extraction.completed', {
      operation: 'extractFromDocument',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return { value: toolUse.input as T, usage };
  }

  /**
   * The judgment half alone, over text the caller already has.
   *
   * Same tool and same schema as `extractFromDocument`, so the fields that come back are the
   * fields the documents module declared and nothing has to be parsed out of prose. The one
   * real difference is what the model is told: it is reading a transcript rather than looking
   * at a page, so `fullText` is *given* to it and must come back unchanged — asking a model to
   * echo text it can already see is the cheapest way to keep one schema for both paths.
   */
  async extractFromText<T>(ctx: AnyContext, request: TextExtractionRequest): Promise<LlmResult<T>> {
    const startedAt = performance.now();

    const response = await this.sdk().messages.create({
      model: MODEL,
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [
        {
          name: 'record_document',
          description: 'Record the fields extracted from the medical document.',
          input_schema: request.schema as Anthropic.Tool['input_schema'],
        },
      ],
      tool_choice: { type: 'tool', name: 'record_document' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.text },
            { type: 'text', text: request.instructions },
          ],
        },
      ],
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Extraction returned no structured result.');
    }

    const usage = {
      model: MODEL,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };

    await ClaudeAdapter.record('llm.extraction.completed', {
      operation: 'extractFromText',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      chars: request.text.length,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return { value: toolUse.input as T, usage };
  }

  async complete(
    ctx: AnyContext,
    prompt: string,
    opts: { maxTokens?: number } = {},
  ): Promise<LlmResult<string>> {
    const startedAt = performance.now();
    const response = await this.sdk().messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const usage = {
      model: MODEL,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };

    await ClaudeAdapter.record('llm.completion.completed', {
      operation: 'complete',
      spaceId: ctx.spaceId,
      requestId: ctx.requestId,
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return { value: text, usage };
  }
}
