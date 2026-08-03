const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth.middleware');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
//
// Valida e-mail + senha em uma única chamada (sem enumeração de usuários).
// A API verifica internamente: e-mail existe → senha confere → ativo → empresa.
//
// Body: { email, senha }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  // Validação básica do payload
  if (!email || !senha) {
    return res.status(400).json({
      success: false,
      message: 'E-mail e senha são obrigatórios.',
    });
  }

  try {
    // Busca usuário + empresa em uma única query
    // ⚠️ Ajuste o nome da tabela de empresas se for diferente de "public.empresas"
    const result = await pool.query(
      `SELECT
         u.codusu,
         u.codemp,
         u.nomeusu,
         u.nomecomp,
         u.email,
         u.senha,
         u.ativo,
         e.nomefantasia
       FROM public.usuarios u
       LEFT JOIN public.empresas e ON e.codemp = u.codemp
       WHERE LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [email.trim()]
    );

    // ── Usuário não encontrado ─────────────────────────────────────────────
    // Mensagem GENÉRICA — não revela se o e-mail existe ou não (anti-enumeração)
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'E-mail ou senha inválidos.',
      });
    }

    const usuario = result.rows[0];

    // ── Senha incorreta ────────────────────────────────────────────────────
    // As senhas estão em texto puro. Quando migrar para bcrypt, troque por:
    // const senhaOk = await bcrypt.compare(senha, usuario.senha);
    const senhaOk = senha === usuario.senha;
    if (!senhaOk) {
      return res.status(401).json({
        success: false,
        message: 'E-mail ou senha inválidos.',
      });
    }

    // ── Usuário inativo ────────────────────────────────────────────────────
    // Coluna "ativo" é TEXT. Aceita: 'S', 's', 'true', '1', 'sim', 'ativo'
    const estaAtivo = ['s', 'sim', 'true', '1', 'ativo'].includes(
      (usuario.ativo || '').toLowerCase()
    );
    if (!estaAtivo) {
      return res.status(403).json({
        success: false,
        code: 'USUARIO_INATIVO',
        message: 'Usuário inativo. Entre em contato com o administrador.',
      });
    }

    // ── Gera token JWT ─────────────────────────────────────────────────────
    // O codemp é embutido no token — a API usa isso, não o que o front manda.
    const token = jwt.sign(
      {
        codusu: usuario.codusu,
        codemp: usuario.codemp,
        email: usuario.email,
      },
      JWT_SECRET,
      { expiresIn: '8h' } // ajuste conforme necessidade
    );

    // ── Retorno ────────────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'Login realizado com sucesso.',
      token,
      usuario: {
        codusu: usuario.codusu,
        codemp: usuario.codemp,
        nomeusu: usuario.nomeusu,
        nomecomp: usuario.nomecomp,
        email: usuario.email,
        ativo: usuario.ativo,
        nomefantasia: usuario.nomefantasia || null,
      },
    });

  } catch (err) {
    console.error('[AUTH] Erro no login:', err);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao processar o login.',
    });
  }
});



// ─────────────────────────────────────────────────────────────
// POST /api/auth/login-motorista
//
// Login do app. Identidade separada da web: outra tabela, outro
// identificador e outro conjunto de permissões.
// ─────────────────────────────────────────────────────────────
router.post('/login-motorista', async (req, res) => {
  const { cpf, senha } = req.body;

  if (!cpf || !senha) {
    return res.status(400).json({
      success: false,
      message: 'CPF e senha são obrigatórios.',
    });
  }

  // Normaliza: o app pode mandar com máscara.
  const cpfLimpo = String(cpf).replace(/\D/g, '');

  if (cpfLimpo.length !== 11) {
    return res.status(400).json({
      success: false,
      message: 'CPF inválido. Informe inclusive zeros a esquerda.',
    });
  }

  try {
    const result = await pool.query(
      `SELECT m.codmotorista, m.codconta, m.codemp,
              m.nomeusu, m.nomecomp, m.email, m.telefone,
              m.senha, m.ativo,
              c.nome AS conta_nome
         FROM public.motoristas m
         JOIN public.contas c ON c.codconta = m.codconta
        WHERE m.cpf = $1
          AND m.dhexclusao IS NULL
        LIMIT 1`,
      [cpfLimpo]
    );

    // Mensagem genérica: não revela se o CPF existe.
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'CPF ou senha inválidos.',
      });
    }

    const m = result.rows[0];

    if (senha !== m.senha) {
      return res.status(401).json({
        success: false,
        message: 'CPF ou senha inválidos.',
      });
    }

    const ativo = ['s', 'sim', 'true', '1', 'ativo']
      .includes((m.ativo || '').toLowerCase());

    if (!ativo) {
      return res.status(403).json({
        success: false,
        code: 'MOTORISTA_INATIVO',
        message: 'Cadastro inativo. Procure o responsável pela sua empresa.',
      });
    }

    // O `tipo` é o que impede este token de ser aceito nas rotas
    // da web: sem ele, codmotorista seria lido como codusu.
    const token = jwt.sign(
      {
        tipo: 'MOTORISTA',
        codmotorista: m.codmotorista,
        codconta: m.codconta,
        codemp: m.codemp,
      },
      JWT_SECRET,
      { expiresIn: '30d' } // app fica logado; a web usa 8h
    );

    return res.status(200).json({
      success: true,
      token,
      motorista: {
        codmotorista: m.codmotorista,
        nome: m.nomecomp || m.nomeusu,
        email: m.email,
        telefone: m.telefone,
        conta: m.conta_nome,
      },
    });
  } catch (err) {
    console.error('[AUTH] Erro no login do motorista:', err);
    return res.status(500).json({
      success: false,
      message: 'Erro interno ao processar o login.',
    });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
//
// Valida se o token ainda é válido e retorna os dados do usuário logado.
// Chamado pelo Flutter ao abrir o app para decidir se vai para /login ou /home.
//
// Header: Authorization: Bearer <token>
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    // req.usuario vem do middleware com { codusu, codemp, email }
    const result = await pool.query(
      `SELECT
         u.codusu,
         u.codemp,
         u.nomeusu,
         u.nomecomp,
         u.email,
         u.ativo,
         e.nomefantasia
       FROM public.usuarios u
       LEFT JOIN public.empresas e ON e.codemp = u.codemp
       WHERE u.codusu = $1
       LIMIT 1`,
      [req.usuario.codusu]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });
    }

    const u = result.rows[0];

    // Revalida se ainda está ativo (pode ter sido desativado após o login)
    const estaAtivo = ['s', 'sim', 'true', '1', 'ativo'].includes(
      (u.ativo || '').toLowerCase()
    );
    if (!estaAtivo) {
      return res.status(403).json({
        success: false,
        code: 'USUARIO_INATIVO',
        message: 'Usuário inativo.',
      });
    }

    return res.status(200).json({
      success: true,
      usuario: {
        codusu: u.codusu,
        codemp: u.codemp,
        nomeusu: u.nomeusu,
        nomecomp: u.nomecomp,
        email: u.email,
        ativo: u.ativo,
        nomefantasia: u.nomefantasia || null,
      },
    });

  } catch (err) {
    console.error('[AUTH] Erro no /me:', err);
    return res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
//
// Rota preparada para recuperação de senha.
// Por segurança, sempre retorna 200 mesmo se o e-mail não existir
// (não revela quais e-mails estão cadastrados).
//
// TODO: integrar com serviço de e-mail (Nodemailer, SendGrid, Resend, etc.)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'E-mail obrigatório.' });
  }

  try {
    // Verifica se o e-mail existe (mas não revela isso na resposta)
    const result = await pool.query(
      `SELECT codusu, nomeusu FROM public.usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email.trim()]
    );

    if (result.rows.length > 0) {
      // TODO: gerar token de reset, salvar no banco e enviar e-mail
      // Exemplo com Nodemailer ou Resend:
      //
      // const resetToken = crypto.randomBytes(32).toString('hex');
      // await salvarTokenReset(result.rows[0].codusu, resetToken);
      // await enviarEmailRecuperacao(email, resetToken);

      console.log(`[AUTH] Recuperação solicitada para: ${email}`);
    }

    // Sempre retorna 200 (não vaza se o e-mail existe)
    return res.status(200).json({
      success: true,
      message: 'Se esse e-mail estiver cadastrado, você receberá as instruções em breve.',
    });

  } catch (err) {
    console.error('[AUTH] Erro no forgot-password:', err);
    return res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
//
// No modelo stateless (JWT), o logout é feito pelo front-end limpando o token.
// Esta rota existe para compatibilidade e para eventual blacklist futura.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/logout', authMiddleware, (req, res) => {
  // TODO: se quiser invalidar tokens antes do vencimento,
  // implemente uma blacklist no Redis ou em tabela no PostgreSQL.
  return res.status(200).json({ success: true, message: 'Logout realizado.' });
});

module.exports = router;
