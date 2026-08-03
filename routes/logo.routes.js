// ============================================================
//  routes/logo.routes.js
//  Logotipo da empresa — Entrega Fácil
// ============================================================
//
//  POST   /api/empresas/:codemp/logo   → sobe (multipart, campo "logo")
//  GET    /api/empresas/:codemp/logo   → devolve a imagem (PÚBLICA)
//  DELETE /api/empresas/:codemp/logo   → remove
//
//  Registro no index.js:
//    const logoRoutes = require('./routes/logo.routes');
//    app.use('/api/empresas', logoRoutes);
//
//  ⚠️ Registre ANTES das rotas /empresas do index.js, para o
//     Express casar o caminho mais específico primeiro.
// ============================================================

const express = require('express');
const multer = require('multer');

const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth.middleware');
const { escopoMiddleware, ehAdmin } = require('../middleware/escopo.middleware');

const LIMITE_BYTES = 500 * 1024; // 500 KB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITE_BYTES },
});

// ── Validação por magic bytes ───────────────────────────────
//
//  O Content-Type do multipart vem do cliente e pode ser forjado.
//  Ler os primeiros bytes do arquivo é o único jeito de saber o
//  que ele realmente é.

function tipoReal(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WEBP: "RIFF" .... "WEBP"
  if (buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

// ── Upload ──────────────────────────────────────────────────

router.post(
  '/:codemp/logo',
  authMiddleware,
  escopoMiddleware,
  upload.single('logo'),
  async (req, res) => {
    try {
      const codemp = Number(req.params.codemp);

      if (!req.escopo.empresas.includes(codemp)) {
        return res.status(403).json({ error: 'Empresa não permitida.' });
      }
      if (!ehAdmin(req, codemp)) {
        return res.status(403).json({
          error: 'Apenas administradores podem alterar o logotipo.',
        });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
      }

      const mimetype = tipoReal(req.file.buffer);
      if (!mimetype) {
        return res.status(400).json({
          error: 'Formato inválido. Envie PNG, JPEG ou WEBP.',
        });
      }

      const { rows } = await pool.query(
        `UPDATE public.empresas
            SET logo = $1,
                logo_mimetype = $2,
                logo_bytes = $3,
                logo_dhupload = now()
          WHERE codemp = $4
            AND codconta = $5
        RETURNING codemp, logo_mimetype, logo_bytes, logo_dhupload`,
        [
          req.file.buffer,
          mimetype,
          req.file.size,
          codemp,
          req.escopo.codconta,
        ]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'Empresa não encontrada.' });
      }

      return res.json({ ok: true, ...rows[0] });
    } catch (err) {
      // O multer estoura este código quando passa do limite.
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `Imagem muito grande. O limite é ${LIMITE_BYTES / 1024} KB.`,
        });
      }
      console.error('[logo:upload]', err);
      return res.status(500).json({ error: 'Erro ao salvar o logotipo.' });
    }
  }
);

// ── Leitura ─────────────────────────────────────────────────
//
//  SEM authMiddleware de propósito: a página de rastreio é
//  pública e precisa exibir o logo do remetente. Um logotipo é
//  material de identidade visual, não dado sensível.
//
//  O cache é o que impede o binário de sair do banco a cada
//  carregamento de tela.

router.get('/:codemp/logo', async (req, res) => {
  const codemp = Number(req.params.codemp);
  if (!Number.isInteger(codemp) || codemp <= 0) {
    return res.status(404).end();
  }

  try {
    const { rows } = await pool.query(
      `SELECT logo, logo_mimetype, logo_dhupload
         FROM public.empresas
        WHERE codemp = $1
          AND dhexclusao IS NULL
        LIMIT 1`,
      [codemp]
    );

    if (rows.length === 0 || !rows[0].logo) {
      return res.status(404).end();
    }

    const { logo, logo_mimetype, logo_dhupload } = rows[0];

    // ETag derivado do momento do upload: muda quando o logo
    // muda, e só então o navegador baixa de novo.
    const etag = `"logo-${codemp}-${new Date(logo_dhupload).getTime()}"`;

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', logo_mimetype || 'image/png');
    res.setHeader('Content-Length', logo.length);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 dias
    return res.end(logo);
  } catch (err) {
    console.error('[logo:get]', err);
    return res.status(500).end();
  }
});

// ── Remoção ─────────────────────────────────────────────────

router.delete('/:codemp/logo', authMiddleware, escopoMiddleware, async (req, res) => {
  try {
    const codemp = Number(req.params.codemp);

    if (!req.escopo.empresas.includes(codemp)) {
      return res.status(403).json({ error: 'Empresa não permitida.' });
    }
    if (!ehAdmin(req, codemp)) {
      return res.status(403).json({
        error: 'Apenas administradores podem remover o logotipo.',
      });
    }

    const { rowCount } = await pool.query(
      `UPDATE public.empresas
          SET logo = NULL, logo_mimetype = NULL,
              logo_bytes = NULL, logo_dhupload = NULL
        WHERE codemp = $1 AND codconta = $2`,
      [codemp, req.escopo.codconta]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Empresa não encontrada.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[logo:delete]', err);
    return res.status(500).json({ error: 'Erro ao remover o logotipo.' });
  }
});

module.exports = router;
