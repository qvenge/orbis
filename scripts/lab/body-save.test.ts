import { expect, test } from 'bun:test';
import type { Page, Request } from 'playwright-core';
import { observeBodySave, openReadySideChat } from './scenario';

const id = 'lab-note';
const marker = 'lab-checkpoint';
const reply = { result: { data: { id, bodyRevision: 4, txId: '90300' } } };

function trpc(
  procedures: string,
  options: { input?: object; response?: unknown; post?: boolean } = {},
) {
  const url = new URL(`https://example.test/trpc/${procedures}`);
  const batched = procedures.includes(',');
  if (batched) url.searchParams.set('batch', '1');
  if (!options.post && options.input) url.searchParams.set('input', JSON.stringify(options.input));
  return {
    url: () => url.href,
    method: () => (options.post ? 'POST' : 'GET'),
    postDataJSON: () => options.input,
    response: async () => ({ json: async () => options.response }),
  } as unknown as Request;
}

function probeFixture(saveReply: unknown, postAckRead = true) {
  const listeners = new Set<(req: Request) => void>();
  const read = trpc('entity.get,chat.listMessages', { input: { 0: { id }, 1: { threadId: id } } });
  const unrelated = trpc('entity.get', { input: { id: 'other' } });
  const send = (req: Request) => {
    for (const onRequest of listeners) onRequest(req);
  };
  let finish: (req: Request) => void = () => {};
  const page = {
    on: (_: string, handler: (req: Request) => void) => listeners.add(handler),
    off: (_: string, handler: (req: Request) => void) => listeners.delete(handler),
    waitForEvent: (_: string, opts: { predicate: (req: Request) => boolean }) =>
      new Promise<Request>((resolve) => {
        finish = (req) => {
          if (opts.predicate(req)) resolve(req);
        };
      }),
    waitForTimeout: async () => {
      if (postAckRead) send(read);
      send(unrelated);
    },
  } as unknown as Page;
  const edit = async () => {
    const previous = trpc('entity.update', {
      post: true,
      input: { id, autosave: true, body: 'old text' },
      response: reply,
    });
    const save = trpc('entity.update,entity.update', {
      post: true,
      input: {
        0: { id: 'other', autosave: true, body: marker },
        1: { id, autosave: true, bodyDoc: { doc: { content: [{ text: marker }] } } },
      },
      response: [{ error: { message: 'unrelated error' } }, saveReply],
    });
    send(read);
    send(previous);
    finish(previous);
    send(save);
    send(read);
    finish(save);
  };
  return { page, edit, listeners };
}

test('наблюдение привязано к ACK нужного автосохранения даже внутри пачки', async () => {
  const { page, edit, listeners } = probeFixture(reply);
  expect(await observeBodySave(page, id, marker, edit)).toMatchObject({
    status: 'confirmed',
    bodyRevision: 4,
    txId: '90300',
    beforeRequest: { 'entity.get': 1, 'chat.listMessages': 1 },
    sinceRequest: { 'entity.get': 2, 'chat.listMessages': 2 },
  });
  expect(listeners.size).toBe(0);
});

test('HTTP-ответ с ошибкой в слоте нужной мутации не считается подтверждением', async () => {
  const { page, edit } = probeFixture({ error: { message: 'Conflict' } });
  expect(await observeBodySave(page, id, marker, edit)).toMatchObject({
    status: 'unconfirmed',
    sinceRequest: { 'entity.get': 1, 'chat.listMessages': 1 },
  });
});

test('чтение до разбора ACK входит в итог даже при тишине после ACK', async () => {
  const { page, edit } = probeFixture(reply, false);
  expect(await observeBodySave(page, id, marker, edit)).toMatchObject({
    status: 'confirmed',
    sinceRequest: { 'entity.get': 1, 'chat.listMessages': 1 },
  });
});

function chatFixture({ visible = true, readOk = true } = {}) {
  let open = false;
  const responses: Array<{
    predicate: (response: unknown) => boolean | Promise<boolean>;
    resolve: (response: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const emit = async (request: Request, body: unknown) => {
    const response = { request: () => request, json: async () => body };
    for (const listener of responses) {
      if (await listener.predicate(response)) listener.resolve(response);
    }
  };
  const page = {
    locator: (selector: string) => ({
      getAttribute: async () => String(open),
      waitFor: async () => {
        if (!visible) throw new Error(`fixture: ${selector} не отрисован`);
      },
      click: async () => {
        open = true;
        await emit(trpc('chat.ensureThread', { post: true, input: {} }), {
          result: { data: { threadId: 'active' } },
        });
        await emit(trpc('chat.listMessages', { input: { threadId: 'other' } }), {
          result: { data: [] },
        });
        await emit(
          trpc('chat.listMessages', { input: { threadId: 'active' } }),
          readOk ? { result: { data: [] } } : { error: { message: 'thread failure' } },
        );
        for (const listener of responses) listener.reject(new Error('fixture: response timeout'));
      },
    }),
    waitForResponse: (predicate: (response: unknown) => boolean | Promise<boolean>) =>
      new Promise((resolve, reject) => responses.push({ predicate, resolve, reject })),
  } as unknown as Page;
  return page;
}

test('нажатый toggle без видимого рабочего ThreadView не допускает замер', async () => {
  await expect(openReadySideChat(chatFixture({ visible: false }))).rejects.toThrow('боковой чат');
});

test('пустой ThreadView после ошибки чтения не допускает замер', async () => {
  await expect(openReadySideChat(chatFixture({ readOk: false }))).rejects.toThrow('боковой чат');
});

test('тред готов после успешного чтения именно активного треда и отрисовки', async () => {
  await expect(openReadySideChat(chatFixture())).resolves.toBeUndefined();
});
