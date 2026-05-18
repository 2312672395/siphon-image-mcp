#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://sub.siphonlab.cn/v1';
export const DEFAULT_MODEL = 'gpt-image-2';
export const DEFAULT_FORMAT = 'png';
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'];
export const IMAGE_QUALITY = ['low', 'medium', 'high', 'auto'];
export const IMAGE_BACKGROUND = ['auto', 'opaque'];
export const IMAGE_MODERATION = ['auto', 'low'];
export const POPULAR_SIZES = [
  { label: '1K square', size: '1024x1024', aspect_ratio: '1:1' },
  { label: '1K landscape', size: '1536x1024', aspect_ratio: '3:2' },
  { label: '1K portrait', size: '1024x1536', aspect_ratio: '2:3' },
  { label: '2K square', size: '2048x2048', aspect_ratio: '1:1' },
  { label: '2K widescreen', size: '2048x1152', aspect_ratio: '16:9' },
  { label: '2K vertical', size: '1152x2048', aspect_ratio: '9:16' },
  { label: '4K landscape', size: '3840x2160', aspect_ratio: '16:9' },
  { label: '4K vertical', size: '2160x3840', aspect_ratio: '9:16' },
  { label: 'auto', size: 'auto', aspect_ratio: 'auto' }
];
export const SIZE_CONSTRAINTS = {
  max_edge_px: 3840,
  edge_multiple_px: 16,
  max_long_to_short_ratio: 3,
  min_total_pixels: 655360,
  max_total_pixels: 8294400
};

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_MAX_QUEUE = 60;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 800;
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_HISTORY = 500;
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'expired']);
const IMAGE_INPUT_FIELDS = ['images', 'image', 'image_path', 'image_paths', 'input_image', 'input_images'];
const MASK_INPUT_FIELDS = ['mask', 'mask_path'];

let defaultStore;

export class SiphonImageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SiphonImageError';
    Object.assign(this, details);
  }
}

export function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URL;
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function loadCredentials(options = {}) {
  const env = options.env || process.env;
  const apiKey = firstNonEmpty(env.SIPHON_IMAGE_API_KEY);
  if (!apiKey) {
    throw new SiphonImageError('SIPHON_IMAGE_API_KEY is not configured in the MCP environment.', {
      code: 'api_key_missing',
      category: 'configuration',
      stage: 'local',
      retryable: false
    });
  }
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(firstNonEmpty(env.SIPHON_IMAGE_BASE_URL, DEFAULT_BASE_URL)),
    model: firstNonEmpty(env.SIPHON_IMAGE_MODEL, DEFAULT_MODEL)
  };
}

export function getCapabilities(options = {}) {
  const env = options.env || process.env;
  return {
    ok: true,
    provider: 'siphonlab',
    model: firstNonEmpty(env.SIPHON_IMAGE_MODEL, DEFAULT_MODEL),
    default_model: firstNonEmpty(env.SIPHON_IMAGE_MODEL, DEFAULT_MODEL),
    base_url: normalizeBaseUrl(firstNonEmpty(env.SIPHON_IMAGE_BASE_URL, DEFAULT_BASE_URL)),
    preferred_tool: 'create_image_job',
    tools: ['create_image_job', 'get_image_job_status', 'cancel_image_job', 'download_image_result', 'get_capabilities', 'generate_image', 'list_image_jobs'],
    supports_async: true,
    supports_cancel: true,
    cancel_semantics: 'best_effort',
    supports_idempotency_key: true,
    supports_image_to_image: true,
    supports_mask: true,
    supports_multiple_outputs: true,
    supports_response_url_download: true,
    image_input_fields: IMAGE_INPUT_FIELDS,
    mask_input_fields: MASK_INPUT_FIELDS,
    sizes: POPULAR_SIZES.map((item) => item.size),
    popular_sizes: POPULAR_SIZES,
    size_presets: ['1K', '2K', '4K', 'auto'],
    size_constraints: SIZE_CONSTRAINTS,
    aspect_ratios: ['1:1', '3:2', '2:3', '16:9', '9:16', 'custom'],
    supports_custom_size: true,
    formats: IMAGE_FORMATS,
    output_formats: IMAGE_FORMATS,
    quality: IMAGE_QUALITY,
    background: IMAGE_BACKGROUND,
    moderation: IMAGE_MODERATION,
    statuses: ['queued', 'running', 'succeeded', 'failed', 'canceled', 'expired'],
    default_output_format: DEFAULT_FORMAT,
    default_request_timeout_ms: resolveInt(env.SIPHON_IMAGE_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
    default_max_attempts: resolveInt(env.SIPHON_IMAGE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1),
    max_concurrent_jobs: resolveInt(env.SIPHON_IMAGE_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, 1),
    max_queued_jobs: resolveInt(env.SIPHON_IMAGE_MAX_QUEUE, DEFAULT_MAX_QUEUE, 0)
  };
}

export function buildPayload(input = {}, options = {}) {
  const credentials = options.credentials || { model: DEFAULT_MODEL };
  const prompt = String(input.prompt || '').trim();
  const payload = {
    model: String(input.model || credentials.model || DEFAULT_MODEL),
    prompt,
    size: String(input.size || '1024x1024'),
    n: resolveInt(input.n, 1, 1, 20),
    response_format: String(input.response_format || 'b64_json'),
    stream: input.stream === undefined ? true : Boolean(input.stream)
  };

  const outputFormat = normalizeFormat(input.output_format || input.format || DEFAULT_FORMAT);
  if (outputFormat) payload.output_format = outputFormat;
  copyEnum(payload, input, 'quality', IMAGE_QUALITY);
  if (!payload.quality) payload.quality = 'high';
  copyEnum(payload, input, 'background', IMAGE_BACKGROUND);
  copyEnum(payload, input, 'moderation', IMAGE_MODERATION);
  copyOptional(payload, input, 'output_compression');
  copyOptional(payload, input, 'style');
  copyOptional(payload, input, 'partial_images');

  const refs = collectInputImages(input).map((item) => normalizeImageReference(item, options));
  if (refs.length > 0) payload.images = refs.map((imageUrl) => ({ image_url: imageUrl }));
  const maskRef = firstNonEmpty(input.mask, input.mask_path);
  if (maskRef) payload.mask = { image_url: normalizeImageReference(maskRef, options) };
  copyOptional(payload, input, 'include_revised_prompt');
  copyOptional(payload, input, 'return_revised_prompt');
  validatePayload(payload);
  return payload;
}

export async function generateImage(input = {}, options = {}) {
  const credentials = loadCredentials(options);
  const payload = buildPayload(input, { ...options, credentials });
  const response = await fetchImageWithRetry(credentials, payload, options);
  assertNotCanceled(options);
  const items = await normalizeImageItems(response, credentials, options);
  assertNotCanceled(options);
  const files = await writeImageOutputs(items, payload, input, options);
  return buildSuccessResult({ payload, response, files, retryCount: response.retryCount || 0, action: imageAction(payload) });
}

export function createImageJobStore(options = {}) {
  return {
    jobs: new Map(),
    queue: [],
    idempotency: new Map(),
    runningCount: 0,
    maxConcurrent: resolveInt(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1),
    maxQueue: resolveInt(options.maxQueue, DEFAULT_MAX_QUEUE, 0),
    ttlMs: resolveInt(options.ttlMs, DEFAULT_JOB_TTL_MS, 1),
    maxHistory: resolveInt(options.maxHistory, DEFAULT_MAX_HISTORY, 1)
  };
}

export function createImageJob(input = {}, options = {}) {
  const store = getStore(options);
  refreshStoreLimits(store, options);
  cleanupJobs(store);
  const idempotencyKey = String(input.idempotency_key || '').trim();
  const queuedCount = store.queue.length;
  if (store.runningCount + queuedCount >= store.maxConcurrent + store.maxQueue) {
    return resultFromError(new SiphonImageError('Image job queue is full. Try again later.', {
      code: 'queue_full',
      category: 'local_queue',
      stage: 'local',
      retryable: true
    }));
  }
  try {
    const credentials = loadCredentials(options);
    const payload = buildPayload(input, { ...options, credentials });
    const requestIdentity = imageRequestIdentity(payload, input);
    if (idempotencyKey && store.idempotency.has(idempotencyKey)) {
      const existing = store.jobs.get(store.idempotency.get(idempotencyKey));
      if (existing) {
        if (existing.request_identity === requestIdentity) return summarizeJob(existing, { reused: true });
        return resultFromError(new SiphonImageError('idempotency_key was already used for a different image request.', {
          code: 'idempotency_conflict',
          category: 'local_queue',
          stage: 'local',
          retryable: false
        }));
      }
      store.idempotency.delete(idempotencyKey);
    }
    const now = new Date().toISOString();
    const requestedOutputFormat = normalizeFormat(input.output_format || input.format || DEFAULT_FORMAT) || DEFAULT_FORMAT;
    const job = {
      job_id: createId('img'),
      trace_id: createId('tr'),
      status: 'queued',
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.now() + store.ttlMs).toISOString(),
      action: imageAction(payload),
      payload,
      input: { ...input },
      credentials,
      idempotency_key: idempotencyKey || undefined,
      request_identity: requestIdentity,
      output_format: requestedOutputFormat,
      requested_output_format: requestedOutputFormat,
      controller: new AbortController(),
      retry_count: 0
    };
    store.jobs.set(job.job_id, job);
    if (idempotencyKey) store.idempotency.set(idempotencyKey, job.job_id);
    if (store.runningCount < store.maxConcurrent) {
      startJob(job, store, options);
    } else {
      store.queue.push(job.job_id);
    }
    return summarizeJob(job);
  } catch (error) {
    return resultFromError(error);
  }
}

function assertNotCanceled(options = {}) {
  if (options.signal?.aborted) {
    throw new SiphonImageError('SiphonLab image request was canceled.', {
      code: 'request_canceled',
      category: 'local',
      stage: 'local',
      retryable: false
    });
  }
}

function assertJobActive(job) {
  if (job.cancel_requested || job.controller?.signal?.aborted || job.status === 'canceled') {
    throw new SiphonImageError('Image job was canceled.', {
      code: 'request_canceled',
      category: 'local_queue',
      stage: 'local',
      retryable: false
    });
  }
}

export function getImageJobStatus(input = {}, options = {}) {
  const store = getStore(options);
  cleanupJobs(store);
  const job = requireJob(input.job_id, store);
  return summarizeJob(job, { includeError: true, includeResult: true });
}

export function listImageJobs(input = {}, options = {}) {
  const store = getStore(options);
  cleanupJobs(store);
  const status = String(input.status || '').trim();
  const limit = resolveInt(input.limit, 50, 1, 500);
  const jobs = [...store.jobs.values()]
    .filter((job) => !status || job.status === status)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map((job) => summarizeJob(job, { includeError: true, includeResult: true }));
  return {
    ok: true,
    total: jobs.length,
    running_count: store.runningCount,
    queued_count: store.queue.length,
    max_concurrent_jobs: store.maxConcurrent,
    max_queued_jobs: store.maxQueue,
    jobs
  };
}

export function cancelImageJob(input = {}, options = {}) {
  const store = getStore(options);
  const job = requireJob(input.job_id, store);
  if (TERMINAL.has(job.status)) return summarizeJob(job);
  if (job.status === 'queued') {
    store.queue = store.queue.filter((id) => id !== job.job_id);
    markJob(job, 'canceled');
    return summarizeJob(job);
  }
  job.cancel_requested = true;
  if (job.controller) job.controller.abort('canceled');
  markJob(job, 'canceled');
  return summarizeJob(job, { note: 'Cancellation requested. Upstream work may already be in progress.' });
}

export function downloadImageResult(input = {}, options = {}) {
  const store = getStore(options);
  const job = requireJob(input.job_id, store);
  if (job.status !== 'succeeded') return summarizeJob(job, { includeError: true, includeResult: true });
  const result = summarizeJob(job, { includeResult: true });
  result.metadata_only = input.metadata_only !== false && input.include_image !== true;
  if (input.include_image === true) {
    result.images = (job.files || []).map((file) => ({
      file: file.file,
      b64: fs.readFileSync(file.file).toString('base64'),
      mimeType: file.mime_type
    }));
    if (result.images[0]) {
      result.b64 = result.images[0].b64;
      result.mimeType = result.images[0].mimeType;
    }
  }
  return result;
}

export function resultFromError(error, extra = {}) {
  const classified = classifyError(error);
  return {
    ok: false,
    status: 'failed',
    error: {
      code: classified.code || 'image_error',
      message: redactSecrets(classified.message || String(error)),
      retryable: Boolean(classified.retryable),
      stage: classified.stage || 'unknown',
      category: classified.category || 'unknown',
      ...extra
    }
  };
}

export function stripImageData(value) {
  if (Array.isArray(value)) return value.map(stripImageData);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'b64' || key === 'data') continue;
    out[key] = stripImageData(item);
  }
  return out;
}

export function structuredToolResult(result) {
  return stripImageData(result);
}

export function toolResultContent(result) {
  const content = [{ type: 'text', text: JSON.stringify(stripImageData(result), null, 2) }];
  if (result && result.images && Array.isArray(result.images)) {
    for (const image of result.images) {
      if (image.b64 && image.mimeType) content.push({ type: 'image', data: image.b64, mimeType: image.mimeType });
    }
  }
  return content;
}

export async function callImageTool(name, args = {}, deps = {}) {
  try {
    switch (name) {
      case 'create_image_job':
        return createImageJob(args || {}, deps);
      case 'get_image_job_status':
        return getImageJobStatus(args || {}, deps);
      case 'cancel_image_job':
        return cancelImageJob(args || {}, deps);
      case 'download_image_result':
        return downloadImageResult(args || {}, deps);
      case 'get_capabilities':
        return getCapabilities(deps);
      case 'generate_image':
        return createImageJob(args || {}, deps);
      case 'list_image_jobs':
        return listImageJobs(args || {}, deps);
      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown image tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    return resultFromError(error);
  }
}

export function createServer(deps = {}) {
  const server = new Server({ name: 'siphon-image-mcp', version: packageVersion() }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callImageTool(request.params?.name, request.params?.arguments || {}, deps);
    return {
      content: toolResultContent(result),
      structuredContent: structuredToolResult(result),
      isError: Boolean(result && result.ok === false)
    };
  });
  return server;
}

export async function runServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toolDefinitions() {
  const imageInput = imageInputSchema();
  return [
    { name: 'create_image_job', description: 'Create an async SiphonLab GPT-Image-2 generation or edit job and return job_id immediately.', inputSchema: imageInput },
    { name: 'get_image_job_status', description: 'Get status and metadata for a local SiphonLab image job.', inputSchema: jobIdSchema() },
    { name: 'cancel_image_job', description: 'Best-effort cancel for a queued or running local image job.', inputSchema: jobIdSchema() },
    { name: 'download_image_result', description: 'Return local file metadata for a completed job, optionally including image content.', inputSchema: downloadSchema() },
    { name: 'get_capabilities', description: 'Return supported SiphonLab GPT-Image-2 MCP capabilities and queue limits.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'generate_image', description: 'Compatibility alias. Creates an async image job and returns job_id.', inputSchema: imageInput },
    { name: 'list_image_jobs', description: 'List recent local image jobs, optionally filtered by status.', inputSchema: listJobsSchema() }
  ];
}

function imageInputSchema() {
  const props = {
    prompt: { type: 'string', description: 'Image prompt.' },
    model: { type: 'string', description: 'Model override. Defaults to SIPHON_IMAGE_MODEL or gpt-image-2.' },
    size: { type: 'string', description: 'Image size, for example 1024x1024, 2048x1152, 3840x2160, or auto.' },
    n: { type: 'number', description: 'Number of images to generate.' },
    quality: { type: 'string', enum: IMAGE_QUALITY },
    format: { type: 'string', enum: IMAGE_FORMATS },
    output_format: { type: 'string', enum: IMAGE_FORMATS },
    response_format: { type: 'string', enum: ['b64_json', 'url'] },
    output_path: { type: 'string', description: 'Directory or full file path for generated output.' },
    overwrite: { type: 'boolean', default: false },
    idempotency_key: { type: 'string' },
    image: { type: 'string' },
    images: { type: 'array', items: { type: 'string' } },
    image_path: { type: 'string' },
    image_paths: { type: 'array', items: { type: 'string' } },
    input_image: { type: 'string' },
    input_images: { type: 'array', items: { type: 'string' } },
    mask: { type: 'string' },
    mask_path: { type: 'string' },
    background: { type: 'string', enum: IMAGE_BACKGROUND },
    moderation: { type: 'string', enum: IMAGE_MODERATION },
    output_compression: { type: 'integer' },
    style: { type: 'string' },
    partial_images: { type: 'number' },
    stream: { type: 'boolean' },
    include_revised_prompt: { type: 'boolean' },
    return_revised_prompt: { type: 'boolean' }
  };
  return { type: 'object', properties: props, required: ['prompt'], additionalProperties: false };
}

function jobIdSchema() {
  return {
    type: 'object',
    properties: { job_id: { type: 'string' } },
    required: ['job_id'],
    additionalProperties: false
  };
}

function downloadSchema() {
  const schema = jobIdSchema();
  schema.properties.metadata_only = { type: 'boolean', default: true };
  schema.properties.include_image = { type: 'boolean', default: false };
  return schema;
}

function listJobsSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'canceled', 'expired'] },
      limit: { type: 'number', default: 50 }
    },
    additionalProperties: false
  };
}

function startJob(job, store, options) {
  store.runningCount += 1;
  markJob(job, 'running');
  runJob(job, store, options).catch(() => {});
}

async function runJob(job, store, options) {
  try {
    const response = await fetchImageWithRetry(job.credentials, job.payload, { ...options, signal: job.controller.signal });
    assertJobActive(job);
    job.retry_count = response.retryCount || 0;
    const items = await normalizeImageItems(response, job.credentials, { ...options, signal: job.controller.signal });
    assertJobActive(job);
    const files = await writeImageOutputs(items, job.payload, job.input, { ...options, signal: job.controller.signal });
    assertJobActive(job);
    const result = buildSuccessResult({ payload: job.payload, response, files, retryCount: job.retry_count, action: job.action });
    assertJobActive(job);
    job.files = files;
    job.result = result;
    markJob(job, 'succeeded');
  } catch (error) {
    if (job.cancel_requested || job.controller.signal.aborted) {
      markJob(job, 'canceled');
    } else {
      job.error = resultFromError(error, { trace_id: job.trace_id }).error;
      markJob(job, 'failed');
    }
  } finally {
    store.runningCount = Math.max(0, store.runningCount - 1);
    scheduleNext(store, options);
  }
}

function scheduleNext(store, options) {
  cleanupJobs(store);
  while (store.runningCount < store.maxConcurrent && store.queue.length > 0) {
    const id = store.queue.shift();
    const job = store.jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    startJob(job, store, options);
  }
}

async function fetchImageWithRetry(credentials, payload, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new SiphonImageError('No fetch implementation is available in this Node runtime.', {
      code: 'fetch_missing',
      category: 'runtime',
      stage: 'local',
      retryable: false
    });
  }
  const maxAttempts = resolveInt(options.maxAttempts, resolveInt(options.env?.SIPHON_IMAGE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1), 1);
  const retryDelay = resolveInt(options.retryDelayMs, resolveInt(options.env?.SIPHON_IMAGE_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, 0), 0);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await postImageRequest(fetchImpl, credentials, payload, options);
      return { ...response, retryCount: attempt - 1 };
    } catch (error) {
      const classified = classifyError(error);
      lastError = classified;
      if (!classified.retryable || attempt >= maxAttempts) throw classified;
      await delay(retryDelay * attempt, options.signal);
    }
  }
  throw lastError;
}

async function postImageRequest(fetchImpl, credentials, payload, options = {}) {
  const endpoint = imageAction(payload) === 'edit' ? '/images/edits' : '/images/generations';
  const timeoutMs = resolveInt(options.requestTimeoutMs, resolveInt((options.env || process.env).SIPHON_IMAGE_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1), 1);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort('timeout');
  }, timeoutMs);
  const onAbort = () => controller.abort('canceled');
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(`${credentials.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
        Accept: payload.stream ? 'text/event-stream, application/json' : 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw httpError(response.status, text);
    }
    const contentType = response.headers?.get?.('content-type') || '';
    const parsed = parseImageResponseText(text, contentType);
    return { body: parsed, raw: text, status: response.status, contentType };
  } catch (error) {
    if (timedOut) {
      throw new SiphonImageError('SiphonLab image request timed out.', {
        code: 'network_timeout',
        category: 'network',
        stage: 'network',
        retryable: true
      });
    }
    if (options.signal?.aborted) {
      throw new SiphonImageError('SiphonLab image request was canceled.', {
        code: 'request_canceled',
        category: 'local',
        stage: 'network',
        retryable: false
      });
    }
    throw classifyError(error);
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

function parseImageResponseText(text, contentType = '') {
  const trimmed = String(text || '').trim();
  if (/text\/event-stream/i.test(contentType) || /^data:/m.test(trimmed)) {
    const events = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const match = line.match(/^data:\s*(.*)$/);
      if (!match) continue;
      const data = match[1].trim();
      if (!data || data === '[DONE]') continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        events.push({ text: data });
      }
    }
    const completed = [...events].reverse().find((event) => event?.data || event?.b64_json || event?.url || /completed/i.test(String(event?.type || '')));
    return completed || { events };
  }
  try {
    return JSON.parse(trimmed || '{}');
  } catch {
    throw new SiphonImageError('SiphonLab image API returned invalid JSON.', {
      code: 'response_json_invalid',
      category: 'response_invalid',
      stage: 'upstream',
      retryable: false
    });
  }
}

async function normalizeImageItems(response, credentials, options = {}) {
  const body = response.body || {};
  const candidates = [];
  if (Array.isArray(body.data)) candidates.push(...body.data);
  if (body.b64_json || body.url) candidates.push(body);
  if (Array.isArray(body.events)) {
    for (const event of body.events) {
      if (Array.isArray(event?.data)) candidates.push(...event.data);
      if (event?.b64_json || event?.url) candidates.push(event);
    }
  }
  if (candidates.length === 0) {
    throw new SiphonImageError('SiphonLab image API did not return b64_json, data URL, or image URL.', {
      code: 'image_data_missing',
      category: 'response_invalid',
      stage: 'upstream',
      retryable: false
    });
  }
  const items = [];
  for (const item of candidates) {
    const image = await bytesFromImageItem(item, credentials, options);
    items.push({
      bytes: image.bytes,
      mime_type: image.mime_type,
      source_type: image.source_type,
      revised_prompt: item.revised_prompt || item.revisedPrompt || body.revised_prompt || undefined
    });
  }
  return items;
}

async function bytesFromImageItem(item, credentials, options = {}) {
  if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
    const bytes = Buffer.from(item.b64_json, 'base64');
    const format = imageFormatFromBytes(bytes);
    return { bytes, mime_type: mimeFromFormat(format || 'png'), source_type: 'b64_json' };
  }
  const url = String(item.url || '').trim();
  const dataURL = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (dataURL) {
    const bytes = Buffer.from(dataURL[2], 'base64');
    const format = imageFormatFromBytes(bytes) || formatFromMime(dataURL[1]);
    return { bytes, mime_type: mimeFromFormat(format || DEFAULT_FORMAT), source_type: 'data_url' };
  }
  if (/^https?:\/\//i.test(url)) {
    const fetchImpl = options.fetch || globalThis.fetch;
    const response = await fetchImpl(url, { headers: {}, signal: options.signal });
    if (!response.ok) throw httpError(response.status, await response.text());
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const format = imageFormatFromBytes(bytes) || formatFromMime(response.headers?.get?.('content-type')) || mimeFromUrl(url);
    return {
      bytes,
      mime_type: mimeFromFormat(format || DEFAULT_FORMAT),
      source_type: 'url'
    };
  }
  throw new SiphonImageError('Image item does not contain usable image data.', {
    code: 'image_data_missing',
    category: 'response_invalid',
    stage: 'upstream',
    retryable: false
  });
}

async function writeImageOutputs(items, payload, input, options = {}) {
  const files = [];
  assertNotCanceled(options);
  const requestedOutputFormat = normalizeFormat(input.output_format || input.format || DEFAULT_FORMAT) || DEFAULT_FORMAT;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    assertNotCanceled(options);
    const actualFormat = imageFormatFromBytes(item.bytes) || formatFromMime(item.mime_type) || requestedOutputFormat || DEFAULT_FORMAT;
    const format = normalizeFormat(actualFormat) || DEFAULT_FORMAT;
    const target = resolveOutputPath(input.output_path, {
      format,
      index: i,
      count: items.length,
      prompt: payload.prompt,
      overwrite: input.overwrite === true,
      env: options.env || process.env
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, item.bytes);
    const dimensions = imageDimensions(item.bytes);
    files.push({
      file: target,
      final_file: target,
      format,
      output_format: format,
      mime_type: mimeFromFormat(format),
      bytes: item.bytes.length,
      sha256: crypto.createHash('sha256').update(item.bytes).digest('hex'),
      width: dimensions.width,
      height: dimensions.height,
      source_type: item.source_type,
      requested_output_format: requestedOutputFormat,
      revised_prompt: item.revised_prompt
    });
  }
  return files;
}

function buildSuccessResult({ payload, response, files, retryCount, action }) {
  const first = files[0] || {};
  return {
    ok: true,
    status: 'succeeded',
    model: payload.model,
    action,
    size: payload.size,
    n: files.length,
    format: first.format,
    output_format: first.output_format,
    requested_output_format: first.requested_output_format || payload.output_format,
    quality: payload.quality,
    file: first.file,
    final_file: first.final_file,
    files,
    mime_type: first.mime_type,
    bytes: first.bytes,
    sha256: first.sha256,
    width: first.width,
    height: first.height,
    retry_count: retryCount,
    revised_prompt: first.revised_prompt,
    upstream_status: response.status
  };
}

function summarizeJob(job, options = {}) {
  const base = {
    ok: job.status !== 'failed',
    job_id: job.job_id,
    trace_id: job.trace_id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
    action: job.action,
    model: job.payload?.model,
    size: job.payload?.size,
    n: job.payload?.n,
    retry_count: job.retry_count || 0
  };
  if (options.reused) base.reused = true;
  if (options.note) base.note = options.note;
  if (job.result && (options.includeResult || TERMINAL.has(job.status))) {
    const { ok, status, ...result } = job.result;
    Object.assign(base, result);
  }
  if (job.error && options.includeError) base.error = job.error;
  return base;
}

function requireJob(jobId, store) {
  const id = String(jobId || '').trim();
  const job = store.jobs.get(id);
  if (!job) throw new SiphonImageError(`Unknown image job: ${id}`, {
    code: 'job_not_found',
    category: 'local_queue',
    stage: 'local',
    retryable: false
  });
  return job;
}

function markJob(job, status) {
  job.status = status;
  job.updated_at = new Date().toISOString();
}

function cleanupJobs(store) {
  const now = Date.now();
  for (const job of store.jobs.values()) {
    if (!TERMINAL.has(job.status)) continue;
    if (Date.parse(job.expires_at) < now) {
      markJob(job, 'expired');
      pruneJob(job);
    }
  }
  pruneHistory(store);
  cleanupIdempotency(store);
}

function refreshStoreLimits(store, options = {}) {
  const env = options.env || process.env;
  store.maxConcurrent = resolveInt(options.maxConcurrent, resolveInt(env.SIPHON_IMAGE_MAX_CONCURRENT, store.maxConcurrent || DEFAULT_MAX_CONCURRENT, 1), 1);
  store.maxQueue = resolveInt(options.maxQueue, resolveInt(env.SIPHON_IMAGE_MAX_QUEUE, store.maxQueue || DEFAULT_MAX_QUEUE, 0), 0);
  store.maxHistory = resolveInt(options.maxHistory, resolveInt(env.SIPHON_IMAGE_MAX_HISTORY, store.maxHistory || DEFAULT_MAX_HISTORY, 1), 1);
}

function getStore(options = {}) {
  if (options.store) return options.store;
  if (!defaultStore) defaultStore = createImageJobStore({
    maxConcurrent: resolveInt(process.env.SIPHON_IMAGE_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT, 1),
    maxQueue: resolveInt(process.env.SIPHON_IMAGE_MAX_QUEUE, DEFAULT_MAX_QUEUE, 0),
    maxHistory: resolveInt(process.env.SIPHON_IMAGE_MAX_HISTORY, DEFAULT_MAX_HISTORY, 1)
  });
  return defaultStore;
}

function pruneJob(job) {
  if (job.pruned) return;
  delete job.credentials;
  delete job.input;
  delete job.controller;
  if (job.payload) job.payload = stripImageReferenceData(job.payload);
  job.pruned = true;
}

function pruneHistory(store) {
  const terminalJobs = [...store.jobs.values()]
    .filter((job) => TERMINAL.has(job.status))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const excess = terminalJobs.length - store.maxHistory;
  if (excess <= 0) return;
  for (const job of terminalJobs.slice(0, excess)) {
    store.jobs.delete(job.job_id);
  }
}

function cleanupIdempotency(store) {
  for (const [key, jobId] of store.idempotency.entries()) {
    const job = store.jobs.get(jobId);
    if (!job || job.status === 'expired') store.idempotency.delete(key);
  }
}

function stripImageReferenceData(value) {
  if (Array.isArray(value)) return value.map(stripImageReferenceData);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'image_url' && typeof item === 'string' && /^data:image\//i.test(item)) {
      out[key] = '[redacted image data]';
    } else {
      out[key] = stripImageReferenceData(item);
    }
  }
  return out;
}

function validatePayload(payload) {
  if (!payload.prompt) throw paramError('prompt_required', 'prompt is required.', 'prompt');
  validateSize(payload.size);
  validateEnum('quality', payload.quality, IMAGE_QUALITY);
  validateEnum('output_format', payload.output_format, IMAGE_FORMATS);
  validateEnum('response_format', payload.response_format, ['b64_json', 'url']);
  validateEnum('background', payload.background, IMAGE_BACKGROUND, true);
  validateEnum('moderation', payload.moderation, IMAGE_MODERATION, true);
}

function validateSize(value) {
  if (value === 'auto') return;
  const match = String(value || '').match(/^(\d+)x(\d+)$/);
  if (!match) throw paramError('invalid_size', 'size must be auto or WIDTHxHEIGHT.', 'size', value);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const pixels = width * height;
  const ok = width % SIZE_CONSTRAINTS.edge_multiple_px === 0 &&
    height % SIZE_CONSTRAINTS.edge_multiple_px === 0 &&
    longSide <= SIZE_CONSTRAINTS.max_edge_px &&
    longSide / shortSide <= SIZE_CONSTRAINTS.max_long_to_short_ratio &&
    pixels >= SIZE_CONSTRAINTS.min_total_pixels &&
    pixels <= SIZE_CONSTRAINTS.max_total_pixels;
  if (!ok) throw paramError('invalid_size', 'size is outside GPT-Image-2 constraints.', 'size', value, { constraints: SIZE_CONSTRAINTS });
}

function validateEnum(name, value, allowed, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return;
  if (!allowed.includes(String(value))) throw paramError(`invalid_${name}`, `${name} must be one of: ${allowed.join(', ')}`, name, value);
}

function paramError(code, message, field, value, extra = {}) {
  return new SiphonImageError(message, {
    code,
    category: 'parameter',
    stage: 'local',
    retryable: false,
    field,
    value,
    ...extra
  });
}

function collectInputImages(input) {
  const values = [];
  for (const key of ['image', 'image_path', 'input_image']) {
    if (input[key]) values.push(input[key]);
  }
  for (const key of ['images', 'image_paths', 'input_images']) {
    const item = input[key];
    if (Array.isArray(item)) values.push(...item);
    else if (item) values.push(item);
  }
  return values.filter(Boolean);
}

function normalizeImageReference(value, options = {}) {
  if (value && typeof value === 'object') {
    return normalizeImageReference(value.image_url || value.url || value.path || value.file, options);
  }
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) return text;
  if (/^https?:\/\//i.test(text)) return text;
  const filePath = expandHome(text, options.home);
  const bytes = fs.readFileSync(filePath);
  const mime = mimeFromPath(filePath) || 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function resolveOutputPath(outputPath, context) {
  const format = context.format || DEFAULT_FORMAT;
  const base = outputPath ? expandHome(outputPath) : defaultOutputDir(context.env);
  const looksDirectory = !path.extname(base) || /[\\/]$/.test(base) || (fs.existsSync(base) && fs.statSync(base).isDirectory());
  let target;
  if (looksDirectory) {
    const stem = `${timestampSlug()}-${slugify(context.prompt || 'image')}`;
    const suffix = context.count > 1 ? `-${context.index + 1}` : '';
    target = path.join(base, `${stem}${suffix}.${format}`);
  } else if (context.count > 1) {
    const ext = path.extname(base);
    target = path.join(path.dirname(base), `${path.basename(base, ext)}-${context.index + 1}.${format}`);
  } else {
    target = pathWithFormat(base, format);
  }
  if (context.overwrite) return target;
  return uniquePath(target);
}

function pathWithFormat(filePath, format) {
  const ext = path.extname(filePath);
  if (!ext) return `${filePath}.${format}`;
  const current = normalizeFormat(ext.slice(1));
  if (current === format) return filePath;
  return path.join(path.dirname(filePath), `${path.basename(filePath, ext)}.${format}`);
}

function defaultOutputDir(env = process.env) {
  const explicit = firstNonEmpty(env.SIPHON_IMAGE_OUTPUT_DIR);
  if (explicit) return expandHome(explicit);
  const codexHome = firstNonEmpty(env.CODEX_HOME, path.join(os.homedir(), '.codex'));
  const date = new Date().toISOString().slice(0, 10);
  return path.join(codexHome, 'generated_images', 'siphon_image', date);
}

function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  for (let i = 2; i < 10000; i += 1) {
    const next = path.join(dir, `${stem}-v${i}${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  throw new SiphonImageError('Could not allocate a unique output path.', {
    code: 'output_path_exhausted',
    category: 'filesystem',
    stage: 'local',
    retryable: false
  });
}

function imageAction(payload) {
  return payload.images && payload.images.length > 0 ? 'edit' : 'generate';
}

function imageRequestIdentity(payload, input = {}) {
  const requestedOutputFormat = normalizeFormat(input.output_format || input.format || DEFAULT_FORMAT) || DEFAULT_FORMAT;
  return crypto.createHash('sha256').update(stableStringify({
    payload,
    output_path: input.output_path ? expandHome(input.output_path) : '',
    overwrite: input.overwrite === true,
    requested_output_format: requestedOutputFormat
  })).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function copyOptional(payload, input, key) {
  if (input[key] !== undefined && input[key] !== null && input[key] !== '') payload[key] = input[key];
}

function copyEnum(payload, input, key, allowed) {
  if (input[key] === undefined || input[key] === null || input[key] === '') return;
  payload[key] = String(input[key]);
  validateEnum(key, payload[key], allowed);
}

function normalizeFormat(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  return text === 'jpg' ? 'jpeg' : text;
}

function formatFromMime(mime) {
  const text = String(mime || '').toLowerCase();
  if (text.includes('jpeg') || text.includes('jpg')) return 'jpeg';
  if (text.includes('webp')) return 'webp';
  if (text.includes('png')) return 'png';
  return '';
}

function mimeFromFormat(format) {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function imageFormatFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) return '';
  if (bytes.length >= 8 && bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  return '';
}

function mimeFromUrl(url) {
  try {
    return mimeFromPath(new URL(url).pathname);
  } catch {
    return '';
  }
}

function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes);
  return { width: undefined, height: undefined };
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: undefined, height: undefined };
}

function httpError(status, bodyText) {
  const retryable = status === 429 || status >= 500;
  return new SiphonImageError(`SiphonLab image API HTTP ${status}: ${redactSecrets(bodyText).slice(0, 1000)}`, {
    code: status === 429 ? 'rate_limited' : `http_${status}`,
    category: status === 429 ? 'rate_limit' : 'upstream',
    stage: 'upstream',
    status,
    retryable
  });
}

function classifyError(error) {
  if (error instanceof SiphonImageError) return error;
  const message = redactSecrets(error?.message || String(error));
  const name = String(error?.name || '');
  return new SiphonImageError(message, {
    code: name === 'AbortError' ? 'request_canceled' : 'network_error',
    category: 'network',
    stage: 'network',
    retryable: name !== 'AbortError'
  });
}

function redactSecrets(value) {
  return String(value || '').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***REDACTED***');
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function resolveInt(...args) {
  let fallback = 0;
  let min = Number.NEGATIVE_INFINITY;
  let max = Number.POSITIVE_INFINITY;
  if (args.length >= 2) fallback = args[args.length - 2];
  if (args.length >= 3) min = args[args.length - 1];
  if (args.length >= 4) {
    fallback = args[1];
    min = args[2];
    max = args[3];
  }
  const value = args[0];
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SiphonImageError('Delay canceled.', { code: 'request_canceled', category: 'local', stage: 'local', retryable: false }));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function expandHome(value, home = os.homedir()) {
  const text = String(value || '');
  if (text === '~') return home;
  if (text.startsWith(`~${path.sep}`) || text.startsWith('~/')) return path.join(home, text.slice(2));
  return text;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function slugify(value) {
  const ascii = String(value || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
  return (ascii || 'image').slice(0, 48);
}

function packageVersion() {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(currentFile), '../package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runServer().catch((error) => {
    console.error(redactSecrets(error?.stack || error?.message || String(error)));
    process.exit(1);
  });
}
