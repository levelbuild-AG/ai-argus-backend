const EventEmitter = require('events');

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
}));

jest.mock('~/server/middleware', () => {
  return {
    handleAbortError: jest.fn(),
    cleanupAbortController: jest.fn(),
    createAbortController: jest.fn(() => ({
      abortController: {
        signal: { aborted: false },
        abort: jest.fn(),
        requestCompleted: false,
      },
      onStart: jest.fn(),
    })),
  };
});

jest.mock('~/server/cleanup', () => ({
  disposeClient: jest.fn(),
  clientRegistry: null,
  requestDataMap: new WeakMap(),
}));

jest.mock('~/models', () => ({
  saveMessage: jest.fn(),
}));

const createMockReq = () => {
  const req = new EventEmitter();
  req.body = {
    text: 'hello world',
    endpointOption: {
      endpoint: 'openai',
      modelOptions: { model: 'gpt-4o-mini' },
    },
    conversationId: 'conv-initial',
    isContinued: false,
  };
  req.user = { id: 'user-123' };
  req.headers = {};
  return req;
};

const createMockRes = () => {
  const res = new EventEmitter();
  res.write = jest.fn();
  res.end = jest.fn();
  res.setHeader = jest.fn();
  res.headersSent = false;
  res.finished = false;
  res.writableEnded = false;
  return res;
};

const { sendEvent } = require('@librechat/api');

describe('AgentController progress handling', () => {
  it('emits final SSE payload with escaped citation markers', async () => {
    expect.assertions(4);

    const citationText =
      'Composite: \\ue200turn0file0\\ue201 and \\ue202turn0search6 plus \\ue202turn0news3';

    const sendMessage = jest.fn(async () => {
      return {
        messageId: 'assistant-msg',
        content: [{ type: 'text', text: citationText }],
        attachments: [{ file_search: { sources: [{ fileId: 'file-1' }] } }],
        databasePromise: Promise.resolve({ conversation: { conversationId: 'conv-final' } }),
      };
    });

    const initializeClient = jest.fn().mockResolvedValue({ client: { sendMessage } });
    const addTitle = jest.fn().mockResolvedValue();

    const req = createMockReq();
    const res = createMockRes();

    await new Promise((resolve, reject) => {
      jest.isolateModules(() => {
        const AgentController = require('./request');
        AgentController(req, res, jest.fn(), initializeClient, addTitle)
          .then(resolve)
          .catch(reject);
      });
    });

    const finalCall = sendEvent.mock.calls.find((call) => call[1]?.final === true);
    expect(finalCall).toBeTruthy();
    const payloadText = finalCall[1].responseMessage.content[0].text;
    expect(payloadText).toContain('\\ue200turn0file0\\ue201');
    expect(payloadText).toContain('\\ue202turn0search6');
    expect(payloadText).not.toMatch(/[\uE200-\uE206]/);
  });

  it('passes streaming options to client sendMessage', async () => {
    expect.assertions(3);

    const sendMessage = jest.fn(async (_text, options) => {
      // Baseline controller no longer injects progressCallback; ensure options arrive
      expect(options).toBeTruthy();
      expect(options.progressCallback).toBeUndefined();
      return {
        messageId: 'assistant-msg',
        databasePromise: Promise.resolve({ conversation: { conversationId: 'conv-final' } }),
      };
    });

    const initializeClient = jest.fn().mockResolvedValue({ client: { sendMessage } });
    const addTitle = jest.fn().mockResolvedValue();

    const req = createMockReq();
    const res = createMockRes();

    await new Promise((resolve, reject) => {
      jest.isolateModules(() => {
        const AgentController = require('./request');
        AgentController(req, res, jest.fn(), initializeClient, addTitle)
          .then(resolve)
          .catch(reject);
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  afterAll(() => {
    jest.resetModules();
  });
});
