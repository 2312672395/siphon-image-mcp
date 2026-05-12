import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPayload,
  callImageTool,
  cancelImageJob,
  createImageJob,
  createImageJobStore,
  generateImage,
  getCapabilities,
  getImageJobStatus,
  listImageJobs,
  loadCredentials,
  normalizeBaseUrl,
  resultFromError
} from '../src/server.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

test('normalizeBaseUrl removes trailing slash and appends v1', () => {
  assert.equal(normalizeBaseUrl('https://sub.siphonlab.cn/'), 'https://sub.siphonlab.cn/v1');
  assert.equal(normalizeBaseUrl('https://sub.siphonlab.cn/v1/'), 'https://sub.siphonlab.cn/v1');
});

test('loadCredentials requires SIPHON_IMAGE_API_KEY and redacts errors', () => {
  assert.throws(() => loadCredentials({ env: {} }), /SIPHON_IMAGE_API_KEY/);
  const result = resultFromError(new Error('bad key sk-secretsecretsecret'));
  assert.doesNotMatch(result.error.message, /sk-secretsecretsecret/);
  assert.match(result.error.message, /sk-\*\*\*REDACTED\*\*\*/);
});

test('buildPayload chooses generation and edit endpoints by input images', () => {
  const gen = buildPayload({ prompt: 'cat' }, { credentials: { model: 'gpt-image-2' } });
  assert.equal(gen.model, 'gpt-image-2');
  assert.equal(gen.prompt, 'cat');
  assert.equal(gen.stream, true);
  assert.equal(gen.images, undefined);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-image-test-'));
  const imagePath = path.join(tmp, 'input.png');
  fs.writeFileSync(imagePath, PNG_1X1);
  const edit = buildPayload({ prompt: 'edit', image_path: imagePath, mask_path: imagePath }, { credentials: { model: 'gpt-image-2' } });
  assert.match(edit.images[0].image_url, /^data:image\/png;base64,/);
  assert.match(edit.mask.image_url, /^data:image\/png;base64,/);
});

test('generateImage saves b64_json output and metadata', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-image-test-'));
  const calls = [];
  const result = await generateImage({ prompt: 'cat', output_path: path.join(tmp, 'cat.png') }, {
    env: {
      SIPHON_IMAGE_API_KEY: 'sk-test',
      SIPHON_IMAGE_BASE_URL: 'https://api.example.test'
    },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
      return jsonResponse({ data: [{ b64_json: PNG_1X1.toString('base64'), revised_prompt: 'revised cat' }] });
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api.example.test/v1/images/generations');
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.equal(calls[0].body.model, 'gpt-image-2');
  assert.equal(result.file, path.join(tmp, 'cat.png'));
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(fs.existsSync(result.file), true);
});

test('generateImage saves data URL and URL responses', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-image-test-'));
  const dataUrl = `data:image/png;base64,${PNG_1X1.toString('base64')}`;
  const fromData = await generateImage({ prompt: 'data', output_path: path.join(tmp, 'data.png') }, {
    env: { SIPHON_IMAGE_API_KEY: 'sk-test' },
    fetch: async () => jsonResponse({ data: [{ url: dataUrl }] })
  });
  assert.equal(fromData.files[0].source_type, 'data_url');

  let callCount = 0;
  const fromUrl = await generateImage({ prompt: 'url', output_path: path.join(tmp, 'url.png'), response_format: 'url' }, {
    env: { SIPHON_IMAGE_API_KEY: 'sk-test' },
    fetch: async () => {
      callCount += 1;
      if (callCount === 1) return jsonResponse({ data: [{ url: 'https://cdn.example.test/image.png' }] });
      return new Response(PNG_1X1, { status: 200, headers: { 'content-type': 'image/png' } });
    }
  });
  assert.equal(fromUrl.files[0].source_type, 'url');
  assert.equal(callCount, 2);
});

test('generateImage saves n greater than 1 as multiple files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-image-test-'));
  const result = await generateImage({ prompt: 'set', n: 2, output_path: path.join(tmp, 'set.png') }, {
    env: { SIPHON_IMAGE_API_KEY: 'sk-test' },
    fetch: async () => jsonResponse({
      data: [
        { b64_json: PNG_1X1.toString('base64') },
        { b64_json: PNG_1X1.toString('base64') }
      ]
    })
  });
  assert.equal(result.n, 2);
  assert.equal(result.files.length, 2);
  assert.match(path.basename(result.files[0].file), /set-1\.png$/);
  assert.match(path.basename(result.files[1].file), /set-2\.png$/);
});

test('async job queue enforces concurrency, queue limit, idempotency, and cancel', async () => {
  const store = createImageJobStore({ maxConcurrent: 1, maxQueue: 1 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-image-test-'));
  let resolveFirst;
  const firstFetch = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const options = {
    store,
    env: { SIPHON_IMAGE_API_KEY: 'sk-test', SIPHON_IMAGE_OUTPUT_DIR: tmp },
    maxConcurrent: 1,
    maxQueue: 1,
    fetch: async () => firstFetch
  };
  const first = createImageJob({ prompt: 'first', idempotency_key: 'same' }, options);
  const duplicate = createImageJob({ prompt: 'first', idempotency_key: 'same' }, options);
  const second = createImageJob({ prompt: 'second' }, options);
  const third = createImageJob({ prompt: 'third' }, options);

  assert.equal(first.status, 'running');
  assert.equal(duplicate.job_id, first.job_id);
  assert.equal(duplicate.reused, true);
  assert.equal(second.status, 'queued');
  assert.equal(third.ok, false);
  assert.equal(third.error.code, 'queue_full');

  const canceled = cancelImageJob({ job_id: second.job_id }, { store });
  assert.equal(canceled.status, 'canceled');
  resolveFirst(jsonResponse({ data: [{ b64_json: PNG_1X1.toString('base64') }] }));
  const finalStatus = await waitForStatus(store, first.job_id, 'succeeded');
  assert.equal(finalStatus.status, 'succeeded');
});

test('getCapabilities reports enhanced defaults', () => {
  const caps = getCapabilities({ env: {} });
  assert.equal(caps.model, 'gpt-image-2');
  assert.equal(caps.max_concurrent_jobs, 6);
  assert.equal(caps.max_queued_jobs, 60);
  assert.equal(caps.tools.includes('list_image_jobs'), true);
});

test('callImageTool exposes seven MCP tools including list_image_jobs', async () => {
  const caps = await callImageTool('get_capabilities', {}, { env: {} });
  assert.equal(caps.ok, true);
  const store = createImageJobStore();
  const listed = await callImageTool('list_image_jobs', {}, { store });
  assert.equal(listed.ok, true);
  assert.equal(listed.total, 0);
});

test('listImageJobs filters local jobs', () => {
  const store = createImageJobStore({ maxConcurrent: 1, maxQueue: 60 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siphon-image-test-'));
  const created = createImageJob({ prompt: 'hold' }, {
    store,
    env: { SIPHON_IMAGE_API_KEY: 'sk-test', SIPHON_IMAGE_OUTPUT_DIR: tmp },
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  });
  const running = listImageJobs({ status: 'running' }, { store });
  assert.equal(running.total, 1);
  assert.equal(running.jobs[0].status, 'running');
  cancelImageJob({ job_id: created.job_id }, { store });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function waitForStatus(store, jobId, expected) {
  for (let i = 0; i < 200; i += 1) {
    const status = getImageJobStatus({ job_id: jobId }, { store });
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getImageJobStatus({ job_id: jobId }, { store });
}
