
const API_BASE =
  process.env.CHAT_MUSIC_API_BASE ||
  "https://chatmusic-mocha.vercel.app";

const API_KEY = process.env.API_KEY;

const TOOLS = [
  {
    name: "playSong",
    description: "Search Jamendo and play a song immediately.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Song title and artist" }
      },
      required: ["query"]
    }
  },
  {
    name: "queueSong",
    description: "Queue a song after the current track.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"]
    }
  },
  {
    name: "control",
    description: "Pause or resume playback.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["pause", "resume"]
        }
      },
      required: ["action"]
    }
  },
  {
    name: "skip",
    description: "Skip to the next queued song.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "getState",
    description: "Get current playback, queue and settings.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "updateSettings",
    description: "Customize the music player appearance.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        bg: { type: "string" },
        fg: { type: "string" },
        accent: { type: "string" },
        css: { type: "string" },
        modules: {
          type: "object",
          properties: {
            queue: { type: "boolean" },
            cover: { type: "boolean" }
          }
        }
      }
    }
  }
];

async function apiCall(path, method = "GET", body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    throw new Error(
      data.error || data.message || `API error ${response.status}`
    );
  }

  return data;
}

async function executeTool(name, args = {}) {
  switch (name) {
    case "playSong":
      return apiCall("/api/play", "POST", {
        query: args.query
      });

    case "queueSong":
      return apiCall("/api/queue", "POST", {
        query: args.query
      });

    case "control":
      if (!["pause", "resume"].includes(args.action)) {
        throw new Error("Invalid control action");
      }
      return apiCall("/api/control", "POST", {
        action: args.action
      });

    case "skip":
      return apiCall("/api/skip", "POST", {});

    case "getState":
      return apiCall("/api/state");

    case "updateSettings":
      return apiCall("/api/settings", "POST", args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, {
      error: "MCP requires POST"
    });
  }

  if (!API_KEY ||
      req.headers["x-api-key"] !== API_KEY) {
    return send(res, 401, {
      error: "Unauthorized"
    });
  }

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return send(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
    }
  }

  const { id, method, params = {} } = body || {};

  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled"
  ) {
    res.statusCode = 202;
    return res.end();
  }

  if (method === "initialize") {
    return send(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "chat-music",
          version: "1.0.0"
        }
      }
    });
  }

  if (method === "ping") {
    return send(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {}
    });
  }

  if (method === "tools/list") {
    return send(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS
      }
    });
  }

  if (method === "tools/call") {
    try {
      const result = await executeTool(
        params.name,
        params.arguments || {}
      );

      return send(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ],
          structuredContent: result,
          isError: false
        }
      });

    } catch (error) {
      return send(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: error.message
            }
          ],
          isError: true
        }
      });
    }
  }

  return send(res, 200, {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: "Method not found"
    }
  });
}
