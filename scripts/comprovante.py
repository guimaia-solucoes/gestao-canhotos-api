#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/comprovante.py
Ficha de entrega — Entrega Fácil / GM Tecnologia Web

Lê um JSON no stdin e escreve o PDF no stdout.
Chamado por routes/comprovante.routes.js.

Dependência: reportlab (já instalada no startup do index.js).
"""

import base64
import io
import json
import sys
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, Image, PageTemplate,
    Paragraph, Spacer, Table, TableStyle, KeepTogether,
)

# ── Paleta ──────────────────────────────────────────────────
CINZA_FAIXA = colors.HexColor('#6E6E6E')
CINZA_BORDA = colors.HexColor('#9A9A9A')
CINZA_TEXTO = colors.HexColor('#333333')
CINZA_CLARO = colors.HexColor('#F2F2F2')

LARGURA_UTIL = A4[0] - 30 * mm

# ── Estilos ─────────────────────────────────────────────────
S_TITULO = ParagraphStyle('titulo', fontName='Helvetica-Bold', fontSize=13,
                          leading=15, alignment=1)
S_SUB = ParagraphStyle('sub', fontName='Helvetica', fontSize=7,
                       leading=9, alignment=1, textColor=CINZA_TEXTO)
S_FAIXA = ParagraphStyle('faixa', fontName='Helvetica-Bold', fontSize=8,
                         leading=10, alignment=1, textColor=colors.white)
S_ROTULO = ParagraphStyle('rotulo', fontName='Helvetica-Bold', fontSize=6.5,
                          leading=8, textColor=CINZA_TEXTO)
S_VALOR = ParagraphStyle('valor', fontName='Helvetica', fontSize=7.5,
                         leading=9.5)
S_CEL = ParagraphStyle('cel', fontName='Helvetica', fontSize=7, leading=8.5)
S_CEL_B = ParagraphStyle('celb', fontName='Helvetica-Bold', fontSize=7,
                         leading=8.5)
S_VAZIO = ParagraphStyle('vazio', fontName='Helvetica-Oblique', fontSize=7.5,
                         leading=10, alignment=1, textColor=CINZA_BORDA)
S_ASSIN = ParagraphStyle('assin', fontName='Helvetica-Bold', fontSize=8,
                         leading=10, alignment=1)


# ── Formatação ──────────────────────────────────────────────

def dt(valor, fmt='%d/%m/%y %H:%M:%S'):
    """Formata data vinda do Postgres. Aceita string ISO ou com espaço."""
    if not valor:
        return ''
    texto = str(valor).strip()
    for corte in ('T', ' '):
        pass
    try:
        # Remove o offset (-03) antes de parsear.
        limpo = texto.replace('T', ' ')
        if '+' in limpo[10:]:
            limpo = limpo[:10] + limpo[10:].split('+')[0]
        elif limpo[10:].count('-') > 0:
            idx = limpo.rfind('-')
            if idx > 10:
                limpo = limpo[:idx]
        limpo = limpo.split('.')[0].strip()
        return datetime.strptime(limpo, '%Y-%m-%d %H:%M:%S').strftime(fmt)
    except Exception:
        return texto[:19]


def moeda(v):
    if v is None:
        return ''
    try:
        s = f'{float(v):,.2f}'
        return s.replace(',', '@').replace('.', ',').replace('@', '.')
    except Exception:
        return str(v)


def qtd(v):
    if v is None:
        return ''
    try:
        return f'{float(v):,.2f}'.replace(',', '@').replace('.', ',').replace('@', '.')
    except Exception:
        return str(v)


def doc_formatado(v):
    """Aplica máscara de CNPJ ou CPF."""
    d = ''.join(ch for ch in str(v or '') if ch.isdigit())
    if len(d) == 14:
        return f'{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}'
    if len(d) == 11:
        return f'{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}'
    return str(v or '')


def P(texto, estilo=S_CEL):
    return Paragraph(str(texto or ''), estilo)


# ── Blocos do documento ─────────────────────────────────────

def faixa(titulo):
    """Barra cinza de seção, como no modelo."""
    t = Table([[Paragraph(titulo, S_FAIXA)]], colWidths=[LARGURA_UTIL])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), CINZA_FAIXA),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return t


def bloco_cabecalho(emit, docu):
    """Logo/emitente à esquerda, números do documento à direita."""
    esq = [
        Paragraph(emit.get('razaosocial') or emit.get('nomefantasia') or '', S_TITULO),
        Spacer(1, 2),
        Paragraph(
            f"CNPJ: {doc_formatado(emit.get('cnpj'))}"
            + (f" | Email: {emit['email']}" if emit.get('email') else ''),
            S_SUB),
        Paragraph(emit.get('endereco') or '', S_SUB),
    ]

    dir_ = Table([
        [Paragraph('Nro. Único', S_ROTULO)],
        [Paragraph(f"<b>{docu.get('nro_unico', '')}</b>", S_VALOR)],
        [Paragraph('Nro. NF', S_ROTULO)],
        [Paragraph(f"<b>{docu.get('nro_nf', '')}</b>", S_VALOR)],
    ], colWidths=[32 * mm])
    dir_.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.7, CINZA_BORDA),
        ('LINEBELOW', (0, 1), (0, 1), 0.7, CINZA_BORDA),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
    ]))

    t = Table([[esq, dir_]], colWidths=[LARGURA_UTIL - 34 * mm, 34 * mm])
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    return t


def campo(rotulo, valor):
    """Célula com rótulo pequeno em cima e valor embaixo."""
    return [Paragraph(rotulo, S_ROTULO), Paragraph(str(valor or ''), S_VALOR)]


def bloco_destinatario(d, docu):
    w = LARGURA_UTIL
    linhas = [
        [campo('Razão Social/Nome', d.get('razaosocial')), None, None,
         campo('CNPJ/CPF', doc_formatado(d.get('cgccpf')))],
        [campo('Endereço', d.get('endereco')), None,
         campo('Bairro', d.get('bairro')),
         campo('Telefone', d.get('telefone'))],
        [campo('Cidade', d.get('cidade')),
         campo('UF', d.get('estado')),
         campo('Ordem de carga', docu.get('ordemcarga') or '—'),
         campo('Motorista', docu.get('motorista') or '—')],
    ]

    dados = []
    for linha in linhas:
        dados.append([
            c if c is not None else '' for c in
            [item if not isinstance(item, list) else
             Table([[item[0]], [item[1]]], colWidths=None,
                   style=TableStyle([
                       ('LEFTPADDING', (0, 0), (-1, -1), 0),
                       ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                       ('TOPPADDING', (0, 0), (-1, -1), 0),
                       ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
                   ]))
             for item in linha]
        ])

    larguras = [w * 0.42, w * 0.10, w * 0.24, w * 0.24]
    t = Table(dados, colWidths=larguras)
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('SPAN', (0, 0), (2, 0)),
    ]))
    return t


def tabela_produtos(produtos):
    if not produtos:
        return Table([[Paragraph('Nenhum produto informado.', S_VAZIO)]],
                     colWidths=[LARGURA_UTIL],
                     style=TableStyle([
                         ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
                         ('TOPPADDING', (0, 0), (-1, -1), 6),
                         ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                     ]))

    w = LARGURA_UTIL
    dados = [[P('Cód.', S_CEL_B), P('Produto', S_CEL_B), P('Qtd.', S_CEL_B),
              P('Valor', S_CEL_B), P('Total', S_CEL_B)]]

    soma = 0.0
    for p in produtos:
        soma += float(p.get('total') or 0)
        dados.append([
            P(p.get('codigo')),
            P(p.get('descricao')),
            P(qtd(p.get('quantidade'))),
            P(moeda(p.get('unitario'))),
            P(moeda(p.get('total'))),
        ])

    dados.append(['', '', '', P('Total', S_CEL_B), P(moeda(soma), S_CEL_B)])

    t = Table(dados, colWidths=[w * 0.09, w * 0.55, w * 0.10, w * 0.13, w * 0.13],
              repeatRows=1)
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('BACKGROUND', (0, 0), (-1, 0), CINZA_CLARO),
        ('ALIGN', (2, 0), (-1, -1), 'RIGHT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('SPAN', (0, -1), (2, -1)),
    ]))
    return t


def tabela_financeiro(itens):
    if not itens:
        return None

    w = LARGURA_UTIL
    dados = [[P('Documento', S_CEL_B), P('Vencimento', S_CEL_B),
              P('Valor', S_CEL_B), P('Título', S_CEL_B)]]
    for f in itens:
        dados.append([
            P(f.get('documento')),
            P(dt(f.get('vencimento'), '%d/%m/%Y')),
            P(moeda(f.get('valor'))),
            P(f.get('titulo') or ''),
        ])

    t = Table(dados, colWidths=[w * 0.25, w * 0.20, w * 0.20, w * 0.35],
              repeatRows=1)
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('BACKGROUND', (0, 0), (-1, 0), CINZA_CLARO),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return t


def tabela_ocorrencias(ocorrencias):
    w = LARGURA_UTIL
    if not ocorrencias:
        return Table([[Paragraph('Nenhuma ocorrência registrada.', S_VAZIO)]],
                     colWidths=[w],
                     style=TableStyle([
                         ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
                         ('TOPPADDING', (0, 0), (-1, -1), 6),
                         ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                     ]))

    dados = [[P('Data/Hora', S_CEL_B), P('Ocorrência', S_CEL_B),
              P('Observação', S_CEL_B)]]
    for o in ocorrencias:
        dados.append([
            P(dt(o.get('dhocor'), '%d/%m/%y %H:%M')),
            P(o.get('tipo') or f"#{o.get('codocor', '')}"),
            P(o.get('observacao')),
        ])

    t = Table(dados, colWidths=[w * 0.18, w * 0.32, w * 0.50], repeatRows=1)
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('BACKGROUND', (0, 0), (-1, 0), CINZA_CLARO),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return t


def imagem_de(dado_base64, largura, altura):
    """Cria um Image do ReportLab a partir de base64, ou None."""
    if not dado_base64:
        return None
    try:
        bruto = dado_base64
        if ',' in bruto[:40]:          # data:image/png;base64,...
            bruto = bruto.split(',', 1)[1]
        buf = io.BytesIO(base64.b64decode(bruto))
        img = Image(buf)
        prop = img.imageWidth / float(img.imageHeight or 1)
        if largura / altura > prop:
            img.drawHeight = altura
            img.drawWidth = altura * prop
        else:
            img.drawWidth = largura
            img.drawHeight = largura / prop
        return img
    except Exception as err:
        print(f'[comprovante] imagem ignorada: {err}', file=sys.stderr)
        return None


def tabela_fotos(fotos):
    w = LARGURA_UTIL
    celulas = []

    for f in fotos:
        img = imagem_de(f.get('base64'), w * 0.30, 55 * mm)
        if img is not None:
            celulas.append(img)
        elif f.get('url'):
            celulas.append(Paragraph(
                f"<link href='{f['url']}'>Abrir foto {f.get('seq', '')}</link>",
                S_CEL))

    if not celulas:
        return Table([[Paragraph('Nenhuma foto registrada.', S_VAZIO)]],
                     colWidths=[w],
                     style=TableStyle([
                         ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
                         ('TOPPADDING', (0, 0), (-1, -1), 6),
                         ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                     ]))

    # Três por linha.
    linhas = [celulas[i:i + 3] for i in range(0, len(celulas), 3)]
    for linha in linhas:
        while len(linha) < 3:
            linha.append('')

    t = Table(linhas, colWidths=[w / 3.0] * 3)
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    return t


def bloco_atendimento(a):
    w = LARGURA_UTIL

    eventos = Table([
        [P('Dh. Início:', S_CEL_B), P(dt(a.get('dh_inicio')))],
        [P('Dh. Checkin:', S_CEL_B), P(dt(a.get('dh_checkin')))],
        [P('Dh. Assinatura:', S_CEL_B), P(dt(a.get('dh_assinatura')))],
        [P('Dh. Checkout:', S_CEL_B), P(dt(a.get('dh_checkout')))],
    ], colWidths=[w * 0.14, w * 0.18])
    eventos.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
    ]))

    responsavel = Table([
        [P('Recebedor:', S_CEL_B), P(a.get('recebedor'))],
        [P('Tp. Documento:', S_CEL_B), P(a.get('tipo_documento'))],
        [P('Nr. Documento:', S_CEL_B), P(a.get('nro_documento'))],
    ], colWidths=[w * 0.13, w * 0.21])
    responsavel.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
    ]))

    geo = []
    for rotulo, chave in (('check-in', 'geo_checkin'),
                          ('assinatura', 'geo_assinatura')):
        g = a.get(chave)
        if g:
            url = f"https://www.google.com/maps?q={g['lat']},{g['lng']}"
            geo.append(Paragraph(
                f"<link href='{url}' color='blue'>Geolocalização do {rotulo}</link>",
                S_CEL))
        else:
            geo.append(Paragraph(f'Sem geolocalização do {rotulo}', S_CEL))

    geo_tab = Table([[g] for g in geo], colWidths=[w * 0.34])
    geo_tab.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ]))

    cab = Table([[P('Eventos', S_CEL_B), P('Dados do Responsável', S_CEL_B),
                  P('Geolocalização', S_CEL_B)]],
                colWidths=[w * 0.32, w * 0.34, w * 0.34])
    cab.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('BACKGROUND', (0, 0), (-1, -1), CINZA_CLARO),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))

    corpo = Table([[eventos, responsavel, geo_tab]],
                  colWidths=[w * 0.32, w * 0.34, w * 0.34])
    corpo.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
    ]))

    return [cab, corpo]


def bloco_assinatura(a):
    """Imagem da assinatura (se houver) sobre a linha do cliente."""
    itens = []
    img = imagem_de(a.get('assinatura'), 60 * mm, 22 * mm)
    if img is not None:
        img.hAlign = 'CENTER'
        itens.append(img)
    else:
        itens.append(Spacer(1, 18 * mm))

    linha = Table([['']], colWidths=[70 * mm], rowHeights=[1])
    linha.setStyle(TableStyle([
        ('LINEABOVE', (0, 0), (-1, 0), 0.7, colors.black),
    ]))
    linha.hAlign = 'CENTER'
    itens.append(linha)
    itens.append(Spacer(1, 3))

    nome = (a.get('recebedor') or '').strip()
    if nome:
        itens.append(Paragraph(nome.upper(), S_ASSIN))
        itens.append(Spacer(1, 2))
    itens.append(Paragraph('Assinatura do Cliente', S_ASSIN))

    return KeepTogether(itens)


# ── Rodapé com paginação ────────────────────────────────────

def rodape(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica', 6.5)
    canvas.setFillColor(CINZA_BORDA)
    canvas.drawString(15 * mm, 10 * mm, 'Ficha de entrega — Entrega Fácil')
    canvas.drawRightString(A4[0] - 15 * mm, 10 * mm, f'Página {doc.page}')
    canvas.restoreState()


# ── Montagem ────────────────────────────────────────────────

def gerar(dados):
    buf = io.BytesIO()

    doc = BaseDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=12 * mm, bottomMargin=15 * mm,
        title=f"Comprovante de entrega {dados['documento'].get('nro_nf', '')}",
        author='Entrega Fácil',
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin,
                  doc.width, doc.height, id='corpo')
    doc.addPageTemplates([PageTemplate(id='padrao', frames=[frame],
                                       onPage=rodape)])

    hist = []
    hist.append(bloco_cabecalho(dados['emitente'], dados['documento']))
    hist.append(Spacer(1, 5))
    hist.append(bloco_destinatario(dados['destinatario'], dados['documento']))
    hist.append(Spacer(1, 8))

    hist.append(faixa('Produtos'))
    hist.append(tabela_produtos(dados.get('produtos') or []))
    hist.append(Spacer(1, 8))

    fin = tabela_financeiro(dados.get('financeiro') or [])
    if fin is not None:
        hist.append(faixa('Financeiro'))
        hist.append(fin)
        hist.append(Spacer(1, 8))

    hist.append(faixa('Ocorrências Registradas'))
    hist.append(tabela_ocorrencias(dados.get('ocorrencias') or []))
    hist.append(Spacer(1, 8))

    hist.append(faixa('Fotos Registradas'))
    hist.append(tabela_fotos(dados.get('fotos') or []))
    hist.append(Spacer(1, 8))

    hist.append(faixa('Informações do Atendimento'))
    hist.extend(bloco_atendimento(dados.get('atendimento') or {}))
    hist.append(Spacer(1, 14))

    hist.append(bloco_assinatura(dados.get('atendimento') or {}))

    doc.build(hist)
    return buf.getvalue()


def main():
    try:
        dados = json.loads(sys.stdin.read())
    except Exception as err:
        print(f'JSON inválido: {err}', file=sys.stderr)
        sys.exit(1)

    try:
        pdf = gerar(dados)
    except Exception as err:
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(2)

    out = sys.stdout.buffer
    out.write(pdf)
    out.flush()


if __name__ == '__main__':
    main()
