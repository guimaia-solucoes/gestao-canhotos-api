const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'troque_por_uma_chave_secreta_forte';

// ─────────────────────────────────────────────────────────────────────────────
// Middleware que valida o token Bearer em rotas protegidas
//
// Uso: app.get('/api/qualquer-rota', authMiddleware, (req, res) => { ... })
// Após validado, disponibiliza req.usuario com { codusu, codemp, email }
// ─────────────────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Token não informado.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.usuario = payload; // { codusu, codemp, email, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token inválido ou expirado.' });
  }
}

module.exports = { authMiddleware, JWT_SECRET };
