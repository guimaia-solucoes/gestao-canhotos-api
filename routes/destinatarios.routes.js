// ============================================================
//  destinatarios.routes.js
//  Cadastro de destinatários (clientes) — Entrega Fácil
//  Caminho: routes/destinatarios.routes.js
// ============================================================
//
//  Toda query é escopada por codemp vindo do JWT. Nenhum
//  endpoint aceita codemp do corpo ou da query string: se
//  aceitasse, bastaria trocar um número na requisição para ler
//  o cadastro de outra empresa.
//
//  Rotas:
//    GET    /api/destinatarios                 lista com filtros
//    GET    /api/destinatarios/:id             um registro
//    GET    /api/destinatarios/documento/:doc  busca por CNPJ/CPF
//    POST   /api/destinatarios                 cadastro manual
//    PUT    /api/destinatarios/:id             edição
//    PATCH  /api/destinatarios/:id/coordenada  ajuste do pino
//    DELETE /api/destinatarios/:id             inativação
// ============================================================

const express = require("express");
const pool = require("../db/pool");
const { authMiddleware } = require("../middleware/auth.middleware");

const router = express.Router();

// ── Identidade do usuário logado ────────────────────────────

function usuarioDoRequest(req) {
  return req.usuario || req.user || req.auth || {};
}

async function resolverCodemp(req) {
  const u = usuarioDoRequest(req);

  const direto = u.codemp ?? u.codEmp ?? u.cod_emp;
  if (direto !== undefined && direto !== null && direto !== "") {
    return Number(direto);
  }

  const codusu = u.codusu ?? u.id ?? u.sub;
  if (codusu === undefined || codusu === null) return null;

  const { rows } = await pool.query(
    "SELECT codemp FROM public.usuarios WHERE codusu = $1 LIMIT 1",
    [codusu]
  );
  return rows[0]?.codemp ?? null;
}

function resolverCodusu(req) {
  const u = usuarioDoRequest(req);
  const codusu = u.codusu ?? u.id ?? u.sub;
  return codusu === undefined || codusu === null ? null : Number(codusu);
}

/// Middleware: resolve o codemp uma vez e barra quem não tem.
async function comEmpresa(req, res, next) {
  const codemp = await resolverCodemp(req);
  if (!codemp) {
    return res.status(400).json({
      ok: false,
      msg: "Não foi possível identificar a empresa do usuário logado.",
    });
  }
  req.codemp = codemp;
  req.codusu = resolverCodusu(req);
  next();
}

// ── Normalização e validação ────────────────────────────────

const texto = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s.slice(0, max);
};

const digitos = (v) => {
  const s = texto(v);
  return s ? s.replace(/\D/g, "") : null;
};

const inteiro = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

const decimal = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/// Campos que a API deixa gravar. Lista explícita, e não
/// Object.keys(body): assim ninguém injeta codemp, id ou
/// data_criacao passando um campo a mais no JSON.
const CAMPOS = {
  razaosocial: (v) => texto(v, 120),
  nomefantasia: (v) => texto(v, 120),
  ie: (v) => texto(v, 20),
  indiedest: inteiro,
  email: (v) => texto(v, 120),
  fone: (v) => (digitos(v) ? digitos(v).slice(0, 20) : null),
  logradouro: (v) => texto(v, 120),
  numero: (v) => texto(v, 20),
  complemento: (v) => texto(v, 120),
  bairro: (v) => texto(v, 80),
  codmunicipio: inteiro,
  municipio: (v) => texto(v, 80),
  uf: (v) => (texto(v, 2) ? texto(v, 2).toUpperCase() : null),
  cep: (v) => (digitos(v) ? digitos(v).padStart(8, "0").slice(0, 8) : null),
  codpais: inteiro,
  pais: (v) => texto(v, 60),
  observacao: (v) => texto(v, 4000),
  ativo: (v) => (String(v).toUpperCase() === "N" ? "N" : "S"),
};

/// Endereço mudou = coordenada antiga não vale mais.
const CAMPOS_DE_ENDERECO = ["logradouro", "numero", "cep"];

function validarDocumento(bruto) {
  const doc = digitos(bruto);
  if (!doc) return { erro: "Informe o CNPJ ou CPF." };

  if (doc.length === 14 || doc.length === 11) {
    return { doc, tipopessoa: doc.length === 14 ? "J" : "F" };
  }
  // 13 ou 10 dígitos quase sempre é zero à esquerda perdido em
  // algum ponto do caminho — completa em vez de recusar.
  if (doc.length === 13) return { doc: doc.padStart(14, "0"), tipopessoa: "J" };
  if (doc.length === 10) return { doc: doc.padStart(11, "0"), tipopessoa: "F" };

  return { erro: "CNPJ deve ter 14 dígitos e CPF, 11." };
}

function validar(dados, { exigirNome }) {
  const erros = [];

  if (exigirNome && !dados.razaosocial) {
    erros.push("Informe a razão social / nome.");
  }
  if (dados.uf !== undefined && dados.uf !== null && dados.uf.length !== 2) {
    erros.push("UF deve ter 2 letras.");
  }
  if (
    dados.indiedest !== undefined &&
    dados.indiedest !== null &&
    ![1, 2, 9].includes(dados.indiedest)
  ) {
    erros.push("Indicador de IE deve ser 1, 2 ou 9.");
  }
  if (dados.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) {
    erros.push("E-mail inválido.");
  }

  return erros;
}

/// Traduz erro do Postgres em resposta útil.
function responderErro(res, err) {
  if (err?.code === "23505") {
    return res
      .status(409)
      .json({ ok: false, msg: "Já existe um destinatário com este CNPJ/CPF." });
  }
  if (err?.code === "23514") {
    return res
      .status(400)
      .json({ ok: false, msg: "Dados fora do formato aceito pelo cadastro." });
  }

  console.error("[destinatarios]", err);
  return res
    .status(500)
    .json({ ok: false, msg: "Erro ao processar a solicitação." });
}

// ============================================================
//  GET /api/destinatarios
// ============================================================
//
//  Filtros: busca (nome, documento, cidade), uf, municipio,
//  ativo, semCoordenada. Paginado — o cadastro cresce com o
//  volume de notas e não cabe numa resposta só.

router.get("/destinatarios", authMiddleware, comEmpresa, async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const pagina = Math.max(Number(req.query.pagina) || 1, 1);
    const offset = (pagina - 1) * limite;

    const where = ["d.codemp = $1"];
    const params = [req.codemp];

    const busca = texto(req.query.busca);
    if (busca) {
      params.push(`%${busca}%`);
      params.push(`%${digitos(busca) || busca}%`);
      where.push(
        `(d.razaosocial ILIKE $${params.length - 1}
          OR d.nomefantasia ILIKE $${params.length - 1}
          OR d.municipio ILIKE $${params.length - 1}
          OR d.cnpjcpf LIKE $${params.length})`
      );
    }

    const uf = texto(req.query.uf, 2);
    if (uf) {
      params.push(uf.toUpperCase());
      where.push(`d.uf = $${params.length}`);
    }

    const municipio = texto(req.query.municipio);
    if (municipio) {
      params.push(municipio);
      where.push(`d.municipio ILIKE $${params.length}`);
    }

    // Sem o parâmetro, lista só os ativos — o padrão é o que a
    // tela de cadastro precisa mostrar.
    const ativo = texto(req.query.ativo);
    if (ativo !== "TODOS") {
      params.push(ativo === "N" ? "N" : "S");
      where.push(`d.ativo = $${params.length}`);
    }

    if (String(req.query.semCoordenada) === "true") {
      where.push("(d.latitude IS NULL OR d.longitude IS NULL)");
    }

    const filtro = where.join(" AND ");

    const sqlItens = `
      SELECT d.*,
             (d.latitude IS NOT NULL AND d.longitude IS NOT NULL) AS geocodificado
        FROM public.destinatarios d
       WHERE ${filtro}
       ORDER BY d.razaosocial
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const sqlTotais = `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE d.latitude IS NULL OR d.longitude IS NULL
             )::int AS sem_coordenada
        FROM public.destinatarios d
       WHERE ${filtro}
    `;

    const [itens, totais] = await Promise.all([
      pool.query(sqlItens, [...params, limite, offset]),
      pool.query(sqlTotais, params),
    ]);

    res.json({
      ok: true,
      itens: itens.rows,
      total: totais.rows[0].total,
      semCoordenada: totais.rows[0].sem_coordenada,
      pagina,
      limite,
      paginas: Math.ceil(totais.rows[0].total / limite) || 1,
    });
  } catch (err) {
    responderErro(res, err);
  }
});

// ============================================================
//  GET /api/destinatarios/documento/:doc
// ============================================================
//
//  Antes de /:id na ordem de registro — se viesse depois, o
//  Express casaria "documento" como se fosse um id.

router.get(
  "/destinatarios/documento/:doc",
  authMiddleware,
  comEmpresa,
  async (req, res) => {
    try {
      const { doc, erro } = validarDocumento(req.params.doc);
      if (erro) return res.status(400).json({ ok: false, msg: erro });

      const { rows } = await pool.query(
        `SELECT * FROM public.destinatarios
          WHERE codemp = $1 AND cnpjcpf = $2 LIMIT 1`,
        [req.codemp, doc]
      );

      if (!rows[0]) {
        return res
          .status(404)
          .json({ ok: false, msg: "Destinatário não encontrado." });
      }

      res.json({ ok: true, item: rows[0] });
    } catch (err) {
      responderErro(res, err);
    }
  }
);

// ============================================================
//  GET /api/destinatarios/:id
// ============================================================

router.get(
  "/destinatarios/:id",
  authMiddleware,
  comEmpresa,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM public.destinatarios WHERE id = $1 AND codemp = $2",
        [req.params.id, req.codemp]
      );

      if (!rows[0]) {
        return res
          .status(404)
          .json({ ok: false, msg: "Destinatário não encontrado." });
      }

      res.json({ ok: true, item: rows[0] });
    } catch (err) {
      responderErro(res, err);
    }
  }
);

// ============================================================
//  POST /api/destinatarios
// ============================================================
//
//  Cadastro manual — o cliente que não veio por XML.

router.post("/destinatarios", authMiddleware, comEmpresa, async (req, res) => {
  try {
    const b = req.body || {};

    const { doc, tipopessoa, erro } = validarDocumento(b.cnpjcpf ?? b.cnpj ?? b.cpf);
    if (erro) return res.status(400).json({ ok: false, msg: erro });

    const dados = {};
    for (const [campo, converter] of Object.entries(CAMPOS)) {
      if (b[campo] !== undefined) dados[campo] = converter(b[campo]);
    }

    const erros = validar(dados, { exigirNome: true });
    if (erros.length) {
      return res.status(400).json({ ok: false, msg: erros.join(" ") });
    }

    // Coordenada informada na criação é sempre manual: veio de
    // alguém apontando no mapa, não do geocodificador.
    const latitude = decimal(b.latitude);
    const longitude = decimal(b.longitude);
    const temCoordenada = latitude !== null && longitude !== null;

    const colunas = ["codemp", "cnpjcpf", "tipopessoa", "codusuinclusao"];
    const valores = [req.codemp, doc, tipopessoa, req.codusu];

    for (const [campo, valor] of Object.entries(dados)) {
      colunas.push(campo);
      valores.push(valor);
    }

    if (temCoordenada) {
      colunas.push(
        "latitude",
        "longitude",
        "coordenada_manual",
        "origem_geocodificacao",
        "geocodificado_em"
      );
      valores.push(latitude, longitude, true, "manual", new Date());
    }

    const marcadores = valores.map((_, i) => `$${i + 1}`).join(", ");

    const { rows } = await pool.query(
      `INSERT INTO public.destinatarios (${colunas.join(", ")})
       VALUES (${marcadores})
       RETURNING *`,
      valores
    );

    res.status(201).json({ ok: true, item: rows[0] });
  } catch (err) {
    responderErro(res, err);
  }
});

// ============================================================
//  PUT /api/destinatarios/:id
// ============================================================
//
//  Aceita atualização parcial: só o que veio no corpo é
//  gravado. Campo ausente permanece como está — evita que uma
//  tela que edita três campos apague os outros quinze.

router.put("/destinatarios/:id", authMiddleware, comEmpresa, async (req, res) => {
  try {
    const b = req.body || {};

    const { rows: atuais } = await pool.query(
      "SELECT * FROM public.destinatarios WHERE id = $1 AND codemp = $2",
      [req.params.id, req.codemp]
    );

    const atual = atuais[0];
    if (!atual) {
      return res
        .status(404)
        .json({ ok: false, msg: "Destinatário não encontrado." });
    }

    const dados = {};
    for (const [campo, converter] of Object.entries(CAMPOS)) {
      if (b[campo] !== undefined) dados[campo] = converter(b[campo]);
    }

    // Trocar o documento troca a identidade do cadastro — vira
    // outro cliente. Se precisar, cadastre um novo e inative
    // este; assim o histórico de entregas continua coerente.
    if (b.cnpjcpf !== undefined || b.cnpj !== undefined || b.cpf !== undefined) {
      const { doc } = validarDocumento(b.cnpjcpf ?? b.cnpj ?? b.cpf);
      if (doc && doc !== atual.cnpjcpf) {
        return res.status(400).json({
          ok: false,
          msg: "O CNPJ/CPF não pode ser alterado. Cadastre um novo destinatário.",
        });
      }
    }

    if (!Object.keys(dados).length) {
      return res
        .status(400)
        .json({ ok: false, msg: "Nenhum campo para atualizar." });
    }

    const erros = validar(dados, { exigirNome: false });
    if (erros.length) {
      return res.status(400).json({ ok: false, msg: erros.join(" ") });
    }

    const sets = [];
    const valores = [];

    for (const [campo, valor] of Object.entries(dados)) {
      valores.push(valor);
      sets.push(`${campo} = $${valores.length}`);
    }

    // Coordenada explícita no PUT é ajuste manual do pino.
    const latitude = decimal(b.latitude);
    const longitude = decimal(b.longitude);

    if (latitude !== null && longitude !== null) {
      valores.push(latitude, longitude);
      sets.push(
        `latitude = $${valores.length - 1}`,
        `longitude = $${valores.length}`,
        "coordenada_manual = TRUE",
        "origem_geocodificacao = 'manual'",
        "geocodificado_em = NOW()"
      );
    } else if (!atual.coordenada_manual) {
      // Mudou logradouro, número ou CEP: a coordenada antiga
      // aponta para o endereço anterior. Melhor ficar sem pino
      // do que plotar a entrega no lugar errado — a fila de
      // geocodificação repõe depois.
      const mudouEndereco = CAMPOS_DE_ENDERECO.some(
        (c) => dados[c] !== undefined && dados[c] !== atual[c]
      );

      if (mudouEndereco) {
        sets.push(
          "latitude = NULL",
          "longitude = NULL",
          "geocodificado_em = NULL",
          "origem_geocodificacao = NULL"
        );
      }
    }

    valores.push(req.params.id, req.codemp);

    const { rows } = await pool.query(
      `UPDATE public.destinatarios
          SET ${sets.join(", ")}
        WHERE id = $${valores.length - 1} AND codemp = $${valores.length}
        RETURNING *`,
      valores
    );

    res.json({ ok: true, item: rows[0] });
  } catch (err) {
    responderErro(res, err);
  }
});

// ============================================================
//  PATCH /api/destinatarios/:id/coordenada
// ============================================================
//
//  Correção do pino no mapa, sem passar pelo formulário inteiro.

router.patch(
  "/destinatarios/:id/coordenada",
  authMiddleware,
  comEmpresa,
  async (req, res) => {
    try {
      const latitude = decimal(req.body?.latitude);
      const longitude = decimal(req.body?.longitude);

      if (latitude === null || longitude === null) {
        return res
          .status(400)
          .json({ ok: false, msg: "Informe latitude e longitude." });
      }
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return res
          .status(400)
          .json({ ok: false, msg: "Coordenada fora dos limites válidos." });
      }

      const manual = req.body?.manual !== false;
      const origem = manual ? "manual" : texto(req.body?.origem, 20) || "auto";

      const { rows } = await pool.query(
        `UPDATE public.destinatarios
            SET latitude = $3,
                longitude = $4,
                coordenada_manual = $5,
                origem_geocodificacao = $6,
                geocodificado_em = NOW()
          WHERE id = $1 AND codemp = $2
          RETURNING *`,
        [req.params.id, req.codemp, latitude, longitude, manual, origem]
      );

      if (!rows[0]) {
        return res
          .status(404)
          .json({ ok: false, msg: "Destinatário não encontrado." });
      }

      res.json({ ok: true, item: rows[0] });
    } catch (err) {
      responderErro(res, err);
    }
  }
);

// ============================================================
//  DELETE /api/destinatarios/:id
// ============================================================
//
//  Inativa, não apaga. As entregas já importadas referenciam
//  este cliente pelo documento; sumir com o cadastro deixaria
//  o histórico órfão.

router.delete(
  "/destinatarios/:id",
  authMiddleware,
  comEmpresa,
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE public.destinatarios
            SET ativo = 'N'
          WHERE id = $1 AND codemp = $2
          RETURNING id, razaosocial, ativo`,
        [req.params.id, req.codemp]
      );

      if (!rows[0]) {
        return res
          .status(404)
          .json({ ok: false, msg: "Destinatário não encontrado." });
      }

      res.json({ ok: true, item: rows[0], msg: "Destinatário inativado." });
    } catch (err) {
      responderErro(res, err);
    }
  }
);

module.exports = router;
