#!/usr/bin/env node
/**
 * external-agents-extend MCP server — stdio JSON-RPC pump.
 *
 * Zero third-party dependencies (runs on the host's node). Speak MCP over
 * newline-delimited JSON on stdin/stdout; never write anything else to stdout.
 *
 * Debug aid: set AGENT_LOG_WIRE_LOG to a file path to append every inbound and
 * outbound message as `IN <json>` / `OUT <json>` lines.
 */

'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

const { TOOL_DEFINITIONS, callDataTool } = require('./tools');

const SERVER_INFO = { name: 'external-agents-extend', version: '0.0.4' };
const PROTOCOL_FALLBACK = '2024-11-05';
const WIRE_LOG = process.env.AGENT_LOG_WIRE_LOG || '';

const WIDGET_URI = 'ui://external-agents-extend/log.html';
const WIDGET_PATH = path.join(__dirname, 'widget', 'log.html');

function wireLog(dir, msg) {
  if (!WIRE_LOG) return;
  try {
    fs.appendFileSync(WIRE_LOG, `${dir} ${JSON.stringify(msg)}\n`);
  } catch {
    /* logging must never break the server */
  }
}

/** Write one JSON-RPC message to stdout. */
function send(msg) {
  wireLog('OUT', msg);
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const TOOLS = [
  {
    name: 'hello',
    description: 'Smoke-test tool: confirms the external-agents-extend server is connected and responding.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_agent_run_log',
    description: 'Open the agent run log panel (MCP App widget, fullscreen).',
    inputSchema: { type: 'object', properties: {} },
    _meta: {
      ui: {
        resourceUri: WIDGET_URI,
        visibility: ['model', 'app'],
        displayMode: 'fullscreen',
        exclusivePanelKey: 'external-agents-log',
      },
    },
  },
  {
    name: 'show_external_agents',
    description:
      'Show a compact inline card in the conversation listing recent external-agent runs (kimi / cursor / codex) with live status. Click a run in the card to open its live execution log (fullscreen). Use when the user wants to see the delegated external agents of this conversation at a glance.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max runs to show in the card (default 10, max 50)' },
      },
    },
    _meta: {
      ui: {
        resourceUri: WIDGET_URI,
        visibility: ['model', 'app'],
        displayMode: 'inline',
        exclusivePanelKey: 'external-agents-log',
      },
    },
  },
  ...TOOL_DEFINITIONS,
];

const RESOURCES = [
  {
    uri: WIDGET_URI,
    name: 'Agent Log Panel',
    mimeType: 'text/html;profile=mcp-app',
  },
];

/** Dispatch one JSON-RPC message. Notifications produce no reply. */
async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params && params.protocolVersion ? params.protocolVersion : PROTOCOL_FALLBACK,
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications: no reply

    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;

    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const dataResult = callDataTool(name, (params && params.arguments) || {});
      if (dataResult !== null) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: dataResult.text }],
            ...(dataResult.isError ? { isError: true } : null),
          },
        });
        return;
      }
      if (name === 'hello') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `hello from external-agents-extend @ ${new Date().toISOString()}`,
              },
            ],
          },
        });
        return;
      }
      if (name === 'open_agent_run_log') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'external-agents-extend panel opened' }],
          },
        });
        return;
      }
      if (name === 'show_external_agents') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'external-agent card shown (click a run to open its live log)' }],
          },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `unknown tool: ${String(name)}` }],
          isError: true,
        },
      });
      return;
    }

    case 'resources/list':
      send({ jsonrpc: '2.0', id, result: { resources: RESOURCES } });
      return;

    case 'resources/read': {
      const uri = params && params.uri;
      if (uri !== WIDGET_URI) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32002, message: `Resource not found: ${String(uri)}` },
        });
        return;
      }
      let html;
      try {
        html = fs.readFileSync(WIDGET_PATH, 'utf8');
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: `Failed to read widget: ${String((err && err.message) || err)}`,
          },
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: html }],
        },
      });
      return;
    }

    default:
      if (!isNotification) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${String(method)}` },
        });
      }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore malformed lines
  }
  wireLog('IN', msg);
  Promise.resolve(handle(msg)).catch((err) => {
    if (msg && msg.id !== undefined && msg.id !== null) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: String((err && err.message) || err) },
      });
    }
  });
});
