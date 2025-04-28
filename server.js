require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const { createClient } = require('redis');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const saltRounds = 10;

// Validación estricta de variables de entorno
const requiredEnvVars = [
  'SESSION_SECRET',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'EMAIL_USER',
  'EMAIL_PASSWORD',
  'NODE_ENV'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ Error: Faltan variables de entorno requeridas:', missingVars.join(', '));
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Redis para sesiones
let redisClient;
(async () => {
  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: {
      reconnectStrategy: retries => Math.min(retries * 100, 5000)
    }
  });

  redisClient.on('error', err => console.error('Redis Error:', err));
  redisClient.on('connect', () => console.log('✅ Conectado a Redis'));
  await redisClient.connect();
})();

// Configuración de seguridad
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middlewares
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Configuración de sesión con Redis
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 3600000
  }
}));

// Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Demasiadas solicitudes desde esta IP, intenta nuevamente más tarde'
});

// Servir archivos estáticos con políticas de seguridad
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// Configuración mejorada de MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'handinhand',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: true,
    ca: process.env.DB_CA_CERT ? Buffer.from(process.env.DB_CA_CERT, 'base64').toString('ascii') : undefined
  } : undefined
});

// Verificación de conexión a MySQL con reintentos
const testDbConnection = async (attempts = 3) => {
  for (let i = 0; i < attempts; i++) {
    try {
      const conn = await pool.getConnection();
      console.log('✅ Conexión a MySQL establecida');
      conn.release();
      return true;
    } catch (err) {
      console.error(`❌ Intento ${i + 1} - Error al conectar a MySQL:`, err.message);
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  console.error('❌ No se pudo conectar a MySQL después de varios intentos');
  process.exit(1);
};

testDbConnection();

// Configuración mejorada de Nodemailer
const createTransporter = () => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    pool: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production'
    }
  });

  transporter.verify(error => {
    if (error) {
      console.error('❌ Error al conectar con el servidor SMTP:', error);
    } else {
      console.log('✅ Conexión SMTP configurada correctamente');
    }
  });

  return transporter;
};

const transporter = createTransporter();

// Health Check Endpoint
app.get('/health', async (req, res) => {
  try {
    const [dbResult] = await pool.query('SELECT 1');
    res.status(200).json({
      status: 'OK',
      db: dbResult ? 'connected' : 'disconnected',
      redis: redisClient.isReady ? 'connected' : 'disconnected',
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(503).json({ status: 'SERVICE_UNAVAILABLE', error: error.message });
  }
});

// Ruta principal con manejo de errores mejorado
app.get('/', (req, res, next) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), {
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'"
      }
    };
  } catch (error) {
    next(new Error('Error al cargar la página principal'));
  }
});

// Endpoint protegido con rate limiting
app.post('/enviar-codigo', apiLimiter, async (req, res, next) => {
  try {
    const { email, nombre, password } = req.body;
    
    // Validación mejorada
    if (!email || !nombre || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Todos los campos son requeridos',
        details: {
          email: !email ? 'Campo requerido' : null,
          nombre: !nombre ? 'Campo requerido' : null,
          password: !password ? 'Campo requerido' : null
        }
      });
    }

    // Validación de formato de email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Formato de correo electrónico inválido'
      });
    }

    // Verificar si el correo ya está registrado
    const [existing] = await pool.execute(
      'SELECT id FROM usuarios WHERE correo_usuario = ?', 
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Este correo ya está registrado'
      });
    }

    // Generar código de verificación seguro
    const codigo = crypto.randomInt(100000, 999999).toString();
    const fechaExpiracion = new Date(Date.now() + 15 * 60 * 1000);
    
    // Plantilla de email mejorada
    const mailOptions = {
      from: `Hand In Hand <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Código de verificación - Hand In Hand',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #28a745;">Hola ${nombre},</h2>
          <p>Por favor utiliza el siguiente código para verificar tu cuenta:</p>
          <div style="font-size: 24px; font-weight: bold; margin: 20px 0; padding: 15px; 
                      background: #f8f9fa; text-align: center; letter-spacing: 2px;">
            ${codigo}
          </div>
          <p style="font-size: 12px; color: #6c757d;">
            Este código expirará el ${fechaExpiracion.toLocaleString()}
          </p>
        </div>
      `,
      text: `Tu código de verificación es: ${codigo}\nVálido hasta: ${fechaExpiracion.toLocaleString()}`
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Correo enviado a ${email}`, info.messageId);
    
    // Guardar datos temporales en la sesión con hash
    req.session.tempUser = {
      email,
      nombre,
      password: await bcrypt.hash(password, saltRounds)
    };
    req.session.codigoGenerado = await bcrypt.hash(codigo, saltRounds);
    req.session.codigoPlain = codigo; // Solo para desarrollo
    req.session.intentos = 0;
    
    res.json({ 
      success: true,
      expiresAt: fechaExpiracion.getTime(),
      message: 'Código enviado correctamente'
    });

  } catch (error) {
    console.error('🔥 Error en /enviar-codigo:', error);
    next(error);
  }
});

// Verificación de código mejorada
app.post('/verificar-codigo', apiLimiter, async (req, res, next) => {
  try {
    const { codigoIngresado } = req.body;
    
    if (!codigoIngresado || typeof codigoIngresado !== 'string' || codigoIngresado.length !== 6) {
      return res.status(400).json({
        success: false,
        error: "El código debe tener exactamente 6 dígitos"
      });
    }

    // Verificar intentos
    req.session.intentos = (req.session.intentos || 0) + 1;
    if (req.session.intentos > 5) {
      return res.status(429).json({
        success: false,
        error: "Demasiados intentos fallidos"
      });
    }

    // Comparación segura con bcrypt
    const match = await bcrypt.compare(codigoIngresado, req.session.codigoGenerado);
    
    if (match) {
      if (!req.session.tempUser?.email) {
        return res.status(400).json({
          success: false,
          error: "Sesión expirada o inválida"
        });
      }

      // Registrar usuario
      const [result] = await pool.execute(
        'INSERT INTO usuarios (nombre_usuario, correo_usuario, contrasena) VALUES (?, ?, ?)',
        [req.session.tempUser.nombre, req.session.tempUser.email, req.session.tempUser.password]
      );

      console.log(`✅ Usuario registrado: ${req.session.tempUser.email} (ID: ${result.insertId})`);
      
      // Limpiar sesión
      req.session.tempUser = null;
      req.session.codigoGenerado = null;
      req.session.intentos = null;
      
      return res.json({ 
        success: true,
        userId: result.insertId,
        message: "Usuario registrado correctamente"
      });
    }

    console.warn(`⚠️ Intento fallido de verificación para ${req.session.tempUser?.email}`);
    res.status(400).json({ 
      success: false,
      error: "Código incorrecto",
      intentosRestantes: 5 - req.session.intentos
    });

  } catch (error) {
    console.error('🔥 Error en /verificar-codigo:', error);
    next(error);
  }
});

// Manejador de errores mejorado
app.use((err, req, res, next) => {
  console.error('🚨 Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method
  });

  const statusCode = err.statusCode || 500;
  const response = {
    success: false,
    error: err.message || 'Error interno del servidor'
  };

  if (process.env.NODE_ENV === 'development') {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
});

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('🛑 Recibida señal de apagado');
  
  server.close(async () => {
    console.log('🔴 Servidor HTTP cerrado');
    
    try {
      await redisClient.quit();
      console.log('🔴 Conexión Redis cerrada');
      await pool.end();
      console.log('🔴 Pool de MySQL cerrado');
      process.exit(0);
    } catch (err) {
      console.error('Error durante el cierre:', err);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error('⏰ Timeout forzando cierre');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Iniciar servidor
const server = app.listen(PORT, () => {
  console.log(`🟢 Servidor corriendo en http://localhost:${PORT} (${process.env.NODE_ENV})`);
}).on('error', (err) => {
  console.error('❌ Error al iniciar servidor:', err);
  process.exit(1);
});

module.exports = server;
