// ============================================================
//  middleware/escopo.middleware.js
//  Resolve conta e empresas acessíveis do usuário logado.
// ============================================================
//
//  Rode DEPOIS do authMiddleware:
//    app.use('/api', authMiddleware, escopoMiddleware, minhasRotas);
//
//  Deixa em req.escopo:
//    { codconta, empresas: [1, 4, 7], perfis: { 1: 'ADMIN', ... } }
//
//  POR QUE consultar o banco a cada requisição em vez de pôr a
//  lista no JWT: permissão muda. Se o admin tirar o acesso de
//  alguém a uma empresa, o token antigo continuaria valendo por
//  8 horas. A query é indexada e devolve poucas linhas.
// ============================================================

const pool = require('../db/pool');

async function escopoMiddleware(req, res, next) {
  const codusu = req.usuario?.codusu;

  if (!codusu) {
    return res.status(401).json({
      success: false,
      message: 'Sessão inválida. Entre novamente.',
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.codconta, ue.codemp, ue.perfil
         FROM public.usuarios u
         LEFT JOIN public.usuarios_empresas ue ON ue.codusu = u.codusu
         LEFT JOIN public.empresas e ON e.codemp = ue.codemp
                                    AND e.dhexclusao IS NULL
        WHERE u.codusu = $1
          AND u.dhexclusao IS NULL`,
      [codusu]
    );

    if (rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Usuário sem acesso configurado.',
      });
    }

    const empresas = [];
    const perfis = {};
    for (const r of rows) {
      if (r.codemp != null) {
        empresas.push(r.codemp);
        perfis[r.codemp] = r.perfil;
      }
    }

    if (empresas.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Usuário não está vinculado a nenhuma empresa.',
      });
    }

    req.escopo = {
      codconta: rows[0].codconta,
      empresas,
      perfis,
    };

    next();
  } catch (err) {
    console.error('[escopo]', err);
    res.status(500).json({ success: false, message: 'Erro ao resolver permissões.' });
  }
}

/**
 * Restringe às empresas pedidas na query (?empresas=1,4), mantendo
 * apenas as que o usuário realmente pode ver. É o filtro do seletor
 * na tela — nunca confie na lista que vem do cliente.
 */
function empresasFiltradas(req) {
  const permitidas = req.escopo.empresas;
  const pedido = req.query.empresas;

  if (!pedido) return permitidas;

  const solicitadas = String(pedido)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Number.isInteger);

  const intersecao = solicitadas.filter((e) => permitidas.includes(e));
  return intersecao.length > 0 ? intersecao : permitidas;
}

/** True se o usuário é ADMIN em pelo menos uma das empresas. */
function ehAdmin(req, codemp = null) {
  const p = req.escopo.perfis;
  if (codemp != null) return p[codemp] === 'ADMIN';
  return Object.values(p).some((v) => v === 'ADMIN');
}

/** Barra escrita para quem só tem perfil de leitura. */
function exigirEscrita(req, res, codemp) {
  const perfil = req.escopo.perfis[codemp];
  if (!perfil || perfil === 'LEITURA') {
    res.status(403).json({ error: 'Sem permissão para alterar dados desta empresa.' });
    return false;
  }
  return true;
}

module.exports = { escopoMiddleware, empresasFiltradas, ehAdmin, exigirEscrita };


// ============================================================
//  PADRÃO DE QUERY — antes e depois
// ============================================================
/*

  ── LEITURA ──────────────────────────────────────────────────

  ANTES:
    WHERE codemp = $1
    params: [codemp]

  DEPOIS:
    WHERE codemp = ANY($1::int[])
    params: [empresasFiltradas(req)]

  O ANY funciona igual para uma ou vinte empresas — o mesmo
  código serve para o cliente pequeno e para o grupo.


  ── LEITURA COM NOME DA EMPRESA ──────────────────────────────

  Na visão consolidada, toda tela precisa dizer de qual empresa
  é cada linha. Junte sempre:

    SELECT e.*, emp.nomefantasia AS empresa_nome
      FROM public.entregas e
      JOIN public.empresas emp ON emp.codemp = e.codemp
     WHERE e.codemp = ANY($1::int[])


  ── MOTORISTAS E VEÍCULOS (compartilhados) ───────────────────

  codemp NULL vale para toda a conta:

    SELECT m.*, emp.nomefantasia AS empresa_nome
      FROM public.motoristas m
      LEFT JOIN public.empresas emp ON emp.codemp = m.codemp
     WHERE m.codconta = $1
       AND (m.codemp IS NULL OR m.codemp = ANY($2::int[]))
       AND m.dhexclusao IS NULL
     ORDER BY m.nomeusu

  params: [req.escopo.codconta, empresasFiltradas(req)]

  Na tela, quem tem empresa_nome nulo aparece como "Todas as
  empresas" — é o sinal de que é compartilhado.


  ── ESCRITA ──────────────────────────────────────────────────

  Aqui NÃO existe consolidado: todo INSERT precisa de UMA empresa.
  O front manda codemp no body, e o backend valida:

    const { codemp } = req.body;

    if (!req.escopo.empresas.includes(Number(codemp))) {
      return res.status(403).json({ error: 'Empresa não permitida.' });
    }
    if (!exigirEscrita(req, res, Number(codemp))) return;

  Este é o ponto crítico do modelo: o codemp passa a vir do body
  (porque o usuário escolhe), então a validação contra a lista do
  escopo é obrigatória. Sem ela, o cliente forja o número e grava
  na empresa de outra conta.


  ── UPDATE E DELETE ──────────────────────────────────────────

    UPDATE public.entregas
       SET ...
     WHERE id = $1
       AND codemp = ANY($2::int[])

  O ANY no WHERE garante que o usuário só altera o que enxerga,
  mesmo passando um id de outra empresa na URL.

*/
