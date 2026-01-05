import { WebSocketServer, WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';
import { verifyToken } from '../lib/supabase.js';
import { User } from '@supabase/supabase-js';

// ============================================
// WEBSOCKET RATE LIMITING (OWASP: Prevent abuse)
// ============================================
const WS_MAX_MESSAGES_PER_MINUTE = 60;    // Max messages per minute per user
const WS_MAX_MESSAGE_SIZE = 65536;         // Max message size (64KB)
const WS_CONNECTION_LIMIT_PER_USER = 3;    // Max concurrent connections per user

// Track message counts for rate limiting (userId -> { count, resetTime })
const messageRateLimits = new Map<string, { count: number; resetTime: number }>();

// Track connections per user for connection limiting
const userConnectionCounts = new Map<string, number>();

/**
 * Check if a user is rate limited for WebSocket messages
 */
function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const limit = messageRateLimits.get(userId);
  
  if (!limit || now >= limit.resetTime) {
    // Reset or initialize rate limit window
    messageRateLimits.set(userId, { count: 1, resetTime: now + 60000 });
    return false;
  }
  
  if (limit.count >= WS_MAX_MESSAGES_PER_MINUTE) {
    return true;
  }
  
  limit.count++;
  return false;
}

/**
 * Check if user has too many concurrent connections
 */
function canConnect(userId: string): boolean {
  const count = userConnectionCounts.get(userId) || 0;
  return count < WS_CONNECTION_LIMIT_PER_USER;
}

/**
 * Track a new connection for a user
 */
function trackConnection(userId: string): void {
  const count = userConnectionCounts.get(userId) || 0;
  userConnectionCounts.set(userId, count + 1);
}

/**
 * Untrack a connection when it closes
 */
function untrackConnection(userId: string): void {
  const count = userConnectionCounts.get(userId) || 0;
  if (count > 1) {
    userConnectionCounts.set(userId, count - 1);
  } else {
    userConnectionCounts.delete(userId);
  }
}

// Extended WebSocket type with user info
interface AuthenticatedWebSocket extends WebSocket {
  user?: User;
  isAlive?: boolean;
}

// Message types
interface WSMessage {
  type: string;
  payload?: unknown;
}

// Active connections map (userId -> WebSocket)
const connections = new Map<string, AuthenticatedWebSocket>();

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ 
    server,
    path: '/ws',
    // OWASP: Limit message size to prevent memory exhaustion
    maxPayload: WS_MAX_MESSAGE_SIZE,
  });

  console.log('🔌 WebSocket server initialized on /ws');

  // Heartbeat to keep connections alive
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const authWs = ws as AuthenticatedWebSocket;
      if (authWs.isAlive === false) {
        console.log('Terminating inactive WebSocket connection');
        return authWs.terminate();
      }
      authWs.isAlive = false;
      authWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', async (ws: AuthenticatedWebSocket, request: IncomingMessage) => {
    console.log('New WebSocket connection attempt');

    // Extract token from query string or headers
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const token = url.searchParams.get('token') || 
                  request.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      console.log('WebSocket connection rejected: No token');
      ws.close(4001, 'Authentication required');
      return;
    }

    // Verify token
    const user = await verifyToken(token);
    if (!user) {
      console.log('WebSocket connection rejected: Invalid token');
      ws.close(4002, 'Invalid token');
      return;
    }

    // OWASP: Check connection limit per user (prevent resource exhaustion)
    if (!canConnect(user.id)) {
      console.log(`WebSocket connection rejected: Too many connections for user ${user.email}`);
      ws.close(4003, 'Too many connections');
      return;
    }

    // Attach user to WebSocket
    ws.user = user;
    ws.isAlive = true;

    // Track and store connection
    trackConnection(user.id);
    connections.set(user.id, ws);
    console.log(`WebSocket connected for user: ${user.email}`);

    // Send welcome message
    sendMessage(ws, {
      type: 'connected',
      payload: {
        message: 'Connected to Readify API',
        userId: user.id,
      },
    });

    // Handle pong (heartbeat response)
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Handle incoming messages with rate limiting (OWASP: Prevent abuse)
    ws.on('message', async (data: RawData) => {
      try {
        // Check rate limit before processing
        if (ws.user && isRateLimited(ws.user.id)) {
          sendMessage(ws, {
            type: 'error',
            payload: { 
              message: 'Rate limited. Please slow down.',
              code: 'RATE_LIMITED',
            },
          });
          return;
        }

        const message = JSON.parse(data.toString()) as WSMessage;
        await handleMessage(ws, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
        sendMessage(ws, {
          type: 'error',
          payload: { message: 'Invalid message format' },
        });
      }
    });

    // Handle connection close
    ws.on('close', () => {
      if (ws.user) {
        connections.delete(ws.user.id);
        untrackConnection(ws.user.id);  // OWASP: Properly clean up connection tracking
        console.log(`WebSocket disconnected for user: ${ws.user.email}`);
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  return wss;
}

// Send a message to a WebSocket client
function sendMessage(ws: WebSocket, message: WSMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Handle incoming messages
async function handleMessage(ws: AuthenticatedWebSocket, message: WSMessage) {
  const user = ws.user;
  if (!user) return;

  console.log(`Received message type: ${message.type} from user: ${user.email}`);

  switch (message.type) {
    case 'ping':
      sendMessage(ws, { type: 'pong' });
      break;

    case 'chat':
      // Future: Forward to OpenAI Realtime API
      await handleChatMessage(ws, message.payload);
      break;

    default:
      sendMessage(ws, {
        type: 'error',
        payload: { message: `Unknown message type: ${message.type}` },
      });
  }
}

// Placeholder for OpenAI chat integration
async function handleChatMessage(ws: AuthenticatedWebSocket, _payload: unknown) {
  // TODO: Implement OpenAI Realtime API integration
  // This is where you'll:
  // 1. Connect to OpenAI's WebSocket API
  // 2. Forward user messages
  // 3. Stream responses back to the client

  sendMessage(ws, {
    type: 'chat_response',
    payload: {
      message: 'OpenAI integration coming soon! This is a placeholder response.',
      timestamp: new Date().toISOString(),
    },
  });
}

// Send message to a specific user
export function sendToUser(userId: string, message: WSMessage) {
  const ws = connections.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendMessage(ws, message);
    return true;
  }
  return false;
}

// Broadcast message to all connected users
export function broadcast(message: WSMessage) {
  connections.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      sendMessage(ws, message);
    }
  });
}

// Get connection count
export function getConnectionCount() {
  return connections.size;
}

