/**
 * danfe.service.js
 * Serviço Node.js para gerar DANFE a partir de XML armazenado no PostgreSQL.
 * 
 * Dependências: pg, python-shell (ou child_process nativo)
 * O danfe_generator.py deve estar na mesma pasta que este arquivo.
 * 
 * Instale: npm install pg
 */

const { Pool } = require('pg');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ou preencha individualmente:
  // host: process.env.DB_HOST,
  // port: process.env.DB_PORT,
  // database: process.env.DB_NAME,
  // user: process.env.DB_USER,
  // password: process.env.DB_PASSWORD,
});

// Caminho para o script Python (mesmo diretório)
const PYTHON_SCRIPT = path.join(__dirname, 'danfe_generator.py');

// Python executável (ajuste se necessário: 'python3' ou 'python')
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

// ─────────────────────────────────────────────────────────────────────────────
// GERA DANFE A PARTIR DE XML STRING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gera o PDF do DANFE a partir de um conteúdo XML (string ou Buffer).
 * Retorna um Buffer com o PDF.
 *
 * @param {string|Buffer} xmlContent - Conteúdo XML da NF-e
 * @returns {Promise<Buffer>} - Buffer com o PDF gerado
 */
async function generateDanfeFromXml(xmlContent) {
  // Cria arquivos temporários para XML de entrada e PDF de saída
  const tmpDir = os.tmpdir();
  const tmpXml = path.join(tmpDir, `nfe_${Date.now()}_${Math.random().toString(36).slice(2)}.xml`);
  const tmpPdf = tmpXml.replace('.xml', '.pdf');

  try {
    // Escreve XML temporário
    fs.writeFileSync(tmpXml, xmlContent, 'utf8');

    // Chama o gerador Python
    await runPython(PYTHON_SCRIPT, [tmpXml, tmpPdf]);

    // Lê o PDF gerado
    const pdfBuffer = fs.readFileSync(tmpPdf);
    return pdfBuffer;

  } finally {
    // Limpa arquivos temporários
    try { fs.unlinkSync(tmpXml); } catch (_) {}
    try { fs.unlinkSync(tmpPdf); } catch (_) {}
  }
}

/**
 * Executa o script Python e retorna uma Promise.
 */
function runPython(scriptPath, args) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [scriptPath, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[DANFE] Erro Python:', stderr || err.message);
        return reject(new Error(`Falha ao gerar DANFE: ${stderr || err.message}`));
      }
      resolve(stdout);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSCA XML NO BANCO E GERA O DANFE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gera DANFE buscando o XML pelo ID da nota no banco de dados.
 * 
 * Ajuste a query SQL conforme sua estrutura de tabelas.
 * Exemplos de colunas comuns: xml_nfe, xml_nota, danfe_xml, conteudo_xml
 *
 * @param {string|number} notaId - ID da nota fiscal no banco
 * @returns {Promise<Buffer>} - Buffer com o PDF
 */
async function generateDanfeByNotaId(notaId) {
  const client = await pool.connect();
  try {
    // ⚠️ AJUSTE a query conforme sua tabela/coluna
    const result = await client.query(
      `SELECT xml_nfe FROM entregas WHERE chavenfe = $1`,
      [notaId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Nota fiscal não encontrada: ID ${notaId}`);
    }

    const xmlContent = result.rows[0].xml_nfe;
    if (!xmlContent) {
      throw new Error(`XML não disponível para a nota ID ${notaId}`);
    }

    return await generateDanfeFromXml(xmlContent);

  } finally {
    client.release();
  }
}

/**
 * Gera DANFE buscando pelo número da nota e série.
 *
 * @param {string} nNF - Número da nota fiscal
 * @param {string} serie - Série da nota
 * @returns {Promise<Buffer>} - Buffer com o PDF
 */
async function generateDanfeByNumero(nNF, serie = '1') {
  const client = await pool.connect();
  try {
    // ⚠️ AJUSTE a query conforme sua tabela/coluna
    const result = await client.query(
      `SELECT xml_nfe FROM notas_fiscais WHERE numero_nf = $1 AND serie = $2`,
      [nNF, serie]
    );

    if (result.rows.length === 0) {
      throw new Error(`Nota fiscal ${nNF}/${serie} não encontrada`);
    }

    return await generateDanfeFromXml(result.rows[0].xml_nfe);

  } finally {
    client.release();
  }
}

/**
 * Gera DANFE buscando pela chave de acesso NF-e (44 dígitos).
 *
 * @param {string} chaveAcesso - Chave de acesso (44 dígitos)
 * @returns {Promise<Buffer>} - Buffer com o PDF
 */
async function generateDanfeByChave(chaveAcesso) {
  const chave = chaveAcesso.replace(/\D/g, '');
  if (chave.length !== 44) {
    throw new Error('Chave de acesso inválida (deve ter 44 dígitos)');
  }

  const client = await pool.connect();
  try {
    // ⚠️ AJUSTE a query conforme sua tabela/coluna
    const result = await client.query(
      `SELECT xml_nfe FROM notas_fiscais WHERE chave_acesso = $1`,
      [chave]
    );

    if (result.rows.length === 0) {
      throw new Error(`Nota fiscal não encontrada para chave: ${chave}`);
    }

    return await generateDanfeFromXml(result.rows[0].xml_nfe);

  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXEMPLO DE ROTA EXPRESS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra as rotas DANFE em um app/router Express.
 * 
 * Uso:
 *   const express = require('express');
 *   const app = express();
 *   const danfeService = require('./danfe.service');
 *   danfeService.registerRoutes(app);
 * 
 * Rotas disponíveis:
 *   GET /api/danfe/:id          → por ID interno do banco
 *   GET /api/danfe/chave/:chave → por chave de acesso NF-e
 */
function registerRoutes(router) {
  // Por ID da nota no banco
  router.get('/api/danfe/:id', async (req, res) => {
    try {
      const pdfBuffer = await generateDanfeByNotaId(req.params.id);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="danfe_${req.params.id}.pdf"`,
        'Content-Length': pdfBuffer.length,
      });
      res.send(pdfBuffer);
    } catch (err) {
      console.error('[DANFE]', err);
      res.status(404).json({ error: err.message });
    }
  });

  // Por chave de acesso
  router.get('/api/danfe/chave/:chave', async (req, res) => {
    try {
      const pdfBuffer = await generateDanfeByChave(req.params.chave);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="danfe_${req.params.chave}.pdf"`,
        'Content-Length': pdfBuffer.length,
      });
      res.send(pdfBuffer);
    } catch (err) {
      console.error('[DANFE]', err);
      res.status(404).json({ error: err.message });
    }
  });
}

module.exports = {
  generateDanfeFromXml,
  generateDanfeByNotaId,
  generateDanfeByNumero,
  generateDanfeByChave,
  registerRoutes,
};
