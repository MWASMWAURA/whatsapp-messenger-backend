// WhatsApp Message Sender Backend with WebSocket Support
// Install required packages:
// npm install @wppconnect-team/wppconnect express ws
const puppeteer = require('puppeteer'); // add this near the other requires
const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Configuration
const PORT = process.env.PORT || 3000; // ✅ FIXED: Use environment variable
const TOKENS_BASE_PATH = path.join(__dirname, 'sessions');
const TOKENS_PATH = path.join(__dirname, 'tokens');

// Ensure directories exist
if (!fs.existsSync(TOKENS_BASE_PATH)) {
  fs.mkdirSync(TOKENS_BASE_PATH, { recursive: true });
}
if (!fs.existsSync(TOKENS_PATH)) {
  fs.mkdirSync(TOKENS_PATH, { recursive: true });
}

// Initialize Express app and WebSocket server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Import keep-alive service
const { keepAlive } = require('./keep-alive');

// Add CORS for Vercel
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  process.env.FRONTEND_URL, // Your production Vercel URL
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Add JSON parsing
app.use(express.json());

// Store active sessions: sessionId -> { client, ws, sessionPath, lastActivity, fingerprint }
const activeSessions = new Map();

// Store initializing sessions to prevent duplicates
const initializingSessions = new Set();

// Serve the HTML file from the same directory
app.get('/', (req, res) => {
  res.json({ 
    message: 'WhatsApp Bulk Messenger Backend',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      status: '/status'
    }
  });
});

// Health check endpoint for keep-alive
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
  
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: uptimeFormatted,
    uptimeSeconds: Math.floor(uptime),
    activeSessions: activeSessions.size,
    initializingSessions: initializingSessions.size,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Status endpoint for monitoring
app.get('/status', (req, res) => {
  const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
    id,
    hasClient: !!session.client,
    hasWebSocket: !!session.ws && session.ws.readyState === WebSocket.OPEN,
    lastActivity: new Date(session.lastActivity).toISOString()
  }));

  res.json({
    activeSessions: sessions,
    totalSessions: activeSessions.size,
    initializingSessions: initializingSessions.size
  });
});

// Generate session ID from browser fingerprint (consistent hash)
function generateSessionId(fingerprint) {
  return crypto
    .createHash('sha256')
    .update(fingerprint)
    .digest('hex')
    .substring(0, 16);
}

// Cleanup inactive sessions (30 minutes timeout)
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 30 * 60 * 1000; // 30 minutes

  activeSessions.forEach(async (session, sessionId) => {
    if (now - session.lastActivity > TIMEOUT) {
      console.log(`⏰ Cleaning up inactive session: ${sessionId}`);
      await cleanupSession(sessionId);
    }
  });
}, 5 * 60 * 1000); // Check every 5 minutes

// Cleanup session
async function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  try {
    console.log(`🧹 Cleaning up session: ${sessionId}`);
    
    // Close WhatsApp client
    if (session.client) {
      try {
        await session.client.close();
      } catch (error) {
        console.log(`⚠️ Error closing client: ${error.message}`);
      }
    }

    // Clean up session directory
    if (session.sessionPath && fs.existsSync(session.sessionPath)) {
      try {
        fs.rmSync(session.sessionPath, { recursive: true, force: true });
        console.log(`🗑️ Session directory cleaned: ${sessionId}`);
      } catch (error) {
        console.log(`⚠️ Could not clean session directory: ${error.message}`);
      }
    }

    activeSessions.delete(sessionId);
    initializingSessions.delete(sessionId);
    console.log(`✅ Session ${sessionId} cleaned up`);
  } catch (error) {
    console.error(`❌ Error cleaning up session ${sessionId}:`, error);
  }
}

// Send message to specific session's WebSocket
function sendToSession(sessionId, data) {
  const session = activeSessions.get(sessionId);
  if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(data));
  }
}

// Initialize WhatsApp client for a specific session
async function initializeWhatsAppSession(sessionId, ws) {
  // Prevent duplicate initialization
  if (initializingSessions.has(sessionId)) {
    console.log(`⚠️ Session ${sessionId} is already initializing, skipping...`);
    return null;
  }

  initializingSessions.add(sessionId);

  try {
    console.log(`🚀 Initializing WhatsApp for session: ${sessionId}`);
    
    // Use consistent session path
    const sessionPath = path.join(TOKENS_BASE_PATH, sessionId);
    
    // Create directory if needed
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    console.log(`📁 Session directory: ${sessionPath}`);

    sendToSession(sessionId, {
      type: 'status',
      message: 'Initializing WhatsApp client...',
      sessionId: sessionId
    });

    // Check for existing session and close it first
    const existingSession = activeSessions.get(sessionId);
    if (existingSession && existingSession.client) {
      try {
        console.log(`🧹 Closing existing client for session: ${sessionId}`);
        await existingSession.client.close();
        // Wait a bit for the browser to fully close
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.log(`⚠️ Error closing existing client: ${error.message}`);
      }
    }

    const client = await wppconnect.create({
      session: sessionId,
      tokensPath: TOKENS_BASE_PATH,
      folderNameToken: sessionId,
      
      catchQR: (base64Qr, asciiQR) => {
        console.log(`📱 QR Code generated for session: ${sessionId}`);
        console.log(`📏 QR length: ${base64Qr?.length || 0}`);
        
        const currentSession = activeSessions.get(sessionId);
        
        if (currentSession && currentSession.ws && currentSession.ws.readyState === WebSocket.OPEN) {
          currentSession.ws.send(JSON.stringify({
            type: 'qr',
            qr: base64Qr,
            sessionId: sessionId
          }));
          console.log(`✅ QR sent to frontend for session: ${sessionId}`);
        } else {
          console.error(`❌ WebSocket not ready for session: ${sessionId}`);
        }
      },
      
      statusFind: (statusSession, session) => {
        console.log(`📊 Session ${sessionId} status:`, statusSession);
        sendToSession(sessionId, {
          type: 'status',
          message: `Status: ${statusSession}`,
          sessionId: sessionId
        });

        if (statusSession === 'inChat' || statusSession === 'qrReadSuccess') {
          sendToSession(sessionId, {
            type: 'ready',
            message: 'WhatsApp connected successfully!',
            sessionId: sessionId
          });
        }
      },
      
      headless: true,
      devtools: false,
      useChrome: false, // << CHANGE THIS to false!
      debug: false,
      logQR: false,
      
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      
      autoClose: 0,
      disableWelcome: true,
      
      puppeteerOptions: {
        executablePath: puppeteer.executablePath(), // ✅ Force Puppeteer Chromium
        userDataDir: path.join(TOKENS_BASE_PATH, sessionId, 'browser-profile'),
        args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
      }
    });

    console.log(`✅ WhatsApp client created for session: ${sessionId}`);
    initializingSessions.delete(sessionId);
    return { client, sessionPath };

  } catch (error) {
    console.error(`❌ Error initializing session ${sessionId}:`, error);
    initializingSessions.delete(sessionId);
    sendToSession(sessionId, {
      type: 'error',
      message: `Failed to initialize: ${error.message}`,
      sessionId: sessionId
    });
    throw error;
  }
}

// Send text message
async function sendMessage(sessionId, phone, message) {
  const session = activeSessions.get(sessionId);
  
  if (!session || !session.client) {
    throw new Error('Session not found or WhatsApp not connected');
  }

  session.lastActivity = Date.now();

  try {
    console.log('==========================================');
    console.log('📱 SENDING MESSAGE:');
    console.log('   Phone:', phone);
    console.log('   Message:', message.substring(0, 50) + '...');
    
    const formattedPhone = phone.includes('@c.us') ? phone : `${phone}@c.us`;
    
    console.log('   Formatted:', formattedPhone);
    console.log('==========================================');
    
    await session.client.sendText(formattedPhone, message);
    console.log(`✅ Message sent successfully to ${formattedPhone}`);
    return { success: true };

  } catch (error) {
    console.error('❌ SEND ERROR:', error.message);
    console.log('==========================================');
    throw error;
  }
}

// Logout and clear session
async function logoutSession(sessionId) {
  const session = activeSessions.get(sessionId);
  
  if (!session) {
    throw new Error('Session not found');
  }

  try {
    console.log(`🚪 Logging out session: ${sessionId}`);
    
    if (session.client) {
      await session.client.logout();
      await session.client.close();
    }

    if (session.sessionPath && fs.existsSync(session.sessionPath)) {
      fs.rmSync(session.sessionPath, { recursive: true, force: true });
      console.log(`🗑️ Session directory cleaned: ${sessionId}`);
    }

    activeSessions.delete(sessionId);
    initializingSessions.delete(sessionId);
    
    console.log(`✅ Session ${sessionId} logged out`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error logging out session ${sessionId}:`, error);
    throw error;
  }
}

// WebSocket connection handler
wss.on('connection', async (ws) => {
  console.log('🔌 New WebSocket connection');
  
  let sessionId = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'init') {
        const fingerprint = message.fingerprint;
        sessionId = generateSessionId(fingerprint);

        console.log(`🆔 Session ID: ${sessionId}`);

        let session = activeSessions.get(sessionId);
        
        if (session && session.client) {
          console.log(`♻️ Restoring existing session: ${sessionId}`);
          
          if (session.ws && session.ws !== ws && session.ws.readyState === WebSocket.OPEN) {
            console.log(`🔄 Closing old WebSocket connection for session: ${sessionId}`);
            session.ws.close();
          }
          
          session.ws = ws;
          session.lastActivity = Date.now();
          
          ws.send(JSON.stringify({ 
            type: 'session-restored',
            sessionId: sessionId,
            message: 'Session restored - WhatsApp already connected'
          }));

          ws.send(JSON.stringify({ 
            type: 'ready',
            sessionId: sessionId,
            message: 'WhatsApp is already connected' 
          }));
          
          return;
        }

        if (initializingSessions.has(sessionId)) {
          const existingSession = activeSessions.get(sessionId);
          
          if (existingSession && existingSession.ws !== ws) {
            console.log(`🔄 Reconnecting existing session: ${sessionId}`);
            
            if (existingSession.ws && existingSession.ws.readyState === WebSocket.OPEN) {
              existingSession.ws.close();
            }
            
            existingSession.ws = ws;
            existingSession.lastActivity = Date.now();
            initializingSessions.delete(sessionId);
            
            ws.send(JSON.stringify({ 
              type: 'status',
              sessionId: sessionId,
              message: 'Reconnected to existing session'
            }));
            
            return;
          } else {
            console.log(`⚠️ Session ${sessionId} already initializing`);
            ws.send(JSON.stringify({ 
              type: 'error',
              sessionId: sessionId,
              message: 'This session is already being initialized. Please wait.'
            }));
            return;
          }
        }
        
        console.log(`✨ Creating new session: ${sessionId}`);
        
        activeSessions.set(sessionId, {
          client: null,
          ws,
          sessionPath: null,
          lastActivity: Date.now(),
          fingerprint
        });
        
        try {
          const result = await initializeWhatsAppSession(sessionId, ws);
          
          if (result) {
            const { client, sessionPath } = result;
            
            const existingSession = activeSessions.get(sessionId);
            if (existingSession) {
              existingSession.client = client;
              existingSession.sessionPath = sessionPath;
            }

            ws.send(JSON.stringify({
              type: 'session-created',
              sessionId: sessionId,
              message: 'New session created'
            }));
          } else {
            activeSessions.delete(sessionId);
            initializingSessions.delete(sessionId);
          }
        } catch (error) {
          console.error(`❌ Failed to initialize session ${sessionId}:`, error);
          activeSessions.delete(sessionId);
          initializingSessions.delete(sessionId);
          
          ws.send(JSON.stringify({
            type: 'error',
            sessionId: sessionId,
            message: `Initialization failed: ${error.message}`
          }));
        }
      }

      else if (message.type === 'send-message') {
        if (!sessionId) {
          ws.send(JSON.stringify({ 
            type: 'error',
            message: 'Session not initialized'
          }));
          return;
        }

        const { phone, message: text } = message;
        
        try {
          await sendMessage(sessionId, phone, text);
          ws.send(JSON.stringify({ 
            type: 'message-sent',
            to: phone,
            sessionId: sessionId
          }));
        } catch (error) {
          ws.send(JSON.stringify({ 
            type: 'message-error',
            error: error.message,
            to: phone,
            sessionId: sessionId
          }));
        }
      }

      else if (message.type === 'logout') {
        if (!sessionId) {
          ws.send(JSON.stringify({ 
            type: 'error',
            message: 'Session not initialized'
          }));
          return;
        }

        try {
          await logoutSession(sessionId);
          ws.send(JSON.stringify({ 
            type: 'logged-out',
            message: 'Logged out successfully',
            sessionId: sessionId
          }));
          
          setTimeout(() => {
            initializingSessions.delete(sessionId);
          }, 3000);
          
        } catch (error) {
          ws.send(JSON.stringify({ 
            type: 'logout-error',
            error: error.message,
            sessionId: sessionId
          }));
        }
      }

    } catch (error) {
      console.error('❌ Error handling WebSocket message:', error);
      ws.send(JSON.stringify({ 
        type: 'error',
        message: error.message
      }));
    }
  });

  ws.on('close', () => {
    console.log(`🔌 WebSocket closed for session: ${sessionId}`);
    
    // Remove from initializing set to allow reconnection
    if (sessionId) {
      initializingSessions.delete(sessionId);
      console.log(`✅ Removed ${sessionId} from initializing set`);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for session ${sessionId}:`, error);
  });
});

// Start server
async function startServer() {
  try {
    console.log('=== STARTING MULTI-USER SERVER ===');

    initializingSessions.clear();
    activeSessions.clear();
    
    server.listen(PORT, () => {
      console.log('✅ SERVER STARTED');
      console.log(`🌐 Server: http://localhost:${PORT}`);
      console.log(`📁 Sessions folder: ${TOKENS_BASE_PATH}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      
      if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`🔗 External URL: ${process.env.RENDER_EXTERNAL_URL}`);
      }
      
      console.log('🚀 Ready for multiple users!');
      
      // Start keep-alive service
      keepAlive();
    });

  } catch (error) {
    console.error('=== ERROR STARTING SERVER ===');
    console.error('Error details:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  console.log(`📊 Closing ${activeSessions.size} active sessions...`);
  for (const [sessionId] of activeSessions) {
    await cleanupSession(sessionId);
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Start the application
startServer();