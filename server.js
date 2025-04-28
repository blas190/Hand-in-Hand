require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const session = require('express-session');
const saltRounds = 10;

// Validación de variables de entorno al inicio
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
  console.error('❌ Error: Faltan variables de entorno EMAIL_USER o EMAIL_PASSWORD');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de sesión
app.use(session({
  secret: process.env.SESSION_SECRET || 'tu_secreto_seguro',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    maxAge: 3600000 // 1 hora
  }
}));

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Configuración de la base de datos MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'handinhand',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Verificar conexión a MySQL
pool.getConnection()
  .then(conn => {
    console.log('✅ Conexión a MySQL establecida');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Error al conectar a MySQL:', err);
    process.exit(1);
  });

// Configuración de Nodemailer
let transporter;
try {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    pool: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  transporter.verify((error) => {
    if (error) {
      console.error('❌ Error al conectar con el servidor SMTP:', error);
    } else {
      console.log('✅ Conexión SMTP configurada correctamente');
    }
  });
} catch (error) {
  console.error('❌ Error fatal al configurar Nodemailer:', error);
  process.exit(1);
}

// Ruta principal
app.get('/', (req, res, next) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (error) {
    next(error);
  }
});

// Enviar código de verificación
app.post('/enviar-codigo', async (req, res, next) => {
  try {
    const { email, nombre, password } = req.body;
    
    if (!email || !nombre || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Todos los campos son requeridos',
        details: {
          email: !email ? 'Campo requerido' : '',
          nombre: !nombre ? 'Campo requerido' : '',
          password: !password ? 'Campo requerido' : ''
        }
      });
    }

    // Verificar si el correo ya está registrado
    const [existing] = await pool.execute(
      'SELECT id FROM usuarios WHERE correo_usuario = ?', 
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Este correo ya está registrado'
      });
    }

    // Generar código de verificación
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const fechaExpiracion = new Date(Date.now() + 15 * 60 * 1000);
    
    // Enviar correo
    const mailOptions = {
      from: `Hand In Hand <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Código de verificación - Hand In Hand',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #28a745;">Hola ${nombre},</h2>
          <p>Tu código de verificación es:</p>
          <div style="font-size: 24px; font-weight: bold; margin: 20px 0; padding: 15px; background: #f8f9fa; text-align: center;">
            ${codigo}
          </div>
          <p>Válido hasta: ${fechaExpiracion.toLocaleString()}</p>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`📧 Correo enviado a ${email}`, info.messageId);
    
    // Guardar datos temporales en la sesión
    req.session.tempUser = { email, nombre, password };
    req.session.codigoGenerado = codigo;
    
    res.json({ 
      success: true,
      codigo,
      expiresAt: fechaExpiracion.getTime(),
      message: 'Código enviado correctamente'
    });

  } catch (error) {
    console.error('🔥 Error en /enviar-codigo:', error);
    next(error);
  }
});

// Verificar código y registrar usuario
app.post('/verificar-codigo', async (req, res, next) => {
  try {
    const { codigoIngresado } = req.body;
    const codigoGenerado = req.session.codigoGenerado;
    const tempUser = req.session.tempUser;
    
    if (!codigoIngresado || !codigoGenerado) {
      return res.status(400).json({ 
        success: false,
        error: "Datos incompletos",
        details: {
          codigoIngresado: !codigoIngresado ? 'Campo requerido' : '',
          codigoGenerado: !codigoGenerado ? 'Código no generado' : ''
        }
      });
    }

    if (typeof codigoIngresado !== 'string' || codigoIngresado.length !== 6) {
      return res.status(400).json({
        success: false,
        error: "El código debe tener exactamente 6 dígitos"
      });
    }

    if (codigoIngresado === codigoGenerado.toString()) {
      if (!tempUser?.email || !tempUser?.nombre || !tempUser?.password) {
        return res.status(400).json({
          success: false,
          error: "Datos de usuario no encontrados"
        });
      }

      // Hashear la contraseña
      const hashedPassword = await bcrypt.hash(tempUser.password, saltRounds);
      
      // Guardar usuario en la base de datos
      const [result] = await pool.execute(
        'INSERT INTO usuarios (nombre_usuario, correo_usuario, contrasena) VALUES (?, ?, ?)',
        [tempUser.nombre, tempUser.email, hashedPassword]
      );

      console.log(`✅ Usuario registrado: ${tempUser.email} (ID: ${result.insertId})`);
      
      // Limpiar datos temporales
      delete req.session.tempUser;
      delete req.session.codigoGenerado;
      
      return res.json({ 
        success: true,
        userId: result.insertId,
        message: "Usuario registrado correctamente"
      });
    }

    console.warn(`⚠️ Intento fallido de verificación con código: ${codigoIngresado}`);
    res.status(400).json({ 
      success: false,
      error: "Código incorrecto" 
    });

  } catch (error) {
    console.error('🔥 Error en /verificar-codigo:', error);
    next(error);
  }
});

// Manejador de errores
app.use((err, req, res, next) => {
  console.error('🚨 Error global:', err);
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: 'Error de validación',
      details: err.errors
    });
  }

  if (err.code === 'ECONNECTION' || err.code === 'EAUTH') {
    return res.status(503).json({
      success: false,
      error: 'Error en el servicio de correo',
      details: 'Por favor intente nuevamente más tarde'
    });
  }

  res.status(500).json({ 
    success: false, 
    error: 'Error interno del servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Manejo de cierre graceful
process.on('SIGTERM', () => {
  console.log('🛑 Recibido SIGTERM. Cerrando servidor...');
  server.close(() => {
    console.log('🔴 Servidor cerrado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Recibido SIGINT. Cerrando servidor...');
  server.close(() => {
    console.log('🔴 Servidor cerrado');
    process.exit(0);
  });
});

// Iniciar servidor
const server = app.listen(PORT, () => {
  console.log(`🟢 Servidor corriendo en http://localhost:${PORT}`);
}).on('error', (err) => {
  console.error('❌ Error al iniciar servidor:', err);
  
  if (err.code === 'EADDRINUSE') {
    console.log(`⚠️  El puerto ${PORT} está en uso. Probando con otro puerto...`);
    app.listen(0, () => {
      console.log(`🟢 Servidor iniciado en puerto alternativo`);
    });
  } else {
    process.exit(1);
  }
});

module.exports = server;