#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/romaneio.py
Romaneio de carga — Entrega Fácil / GM Tecnologia Web

Lê JSON no stdin, escreve PDF no stdout.
Chamado por routes/romaneioPdf.routes.js.
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
    Paragraph, Spacer, Table, TableStyle,
)

# ── Paleta ──────────────────────────────────────────────────
CINZA_FAIXA = colors.HexColor('#6E6E6E')
CINZA_BORDA = colors.HexColor('#9A9A9A')
CINZA_TEXTO = colors.HexColor('#333333')
CINZA_CLARO = colors.HexColor('#F2F2F2')
CINZA_LINHA = colors.HexColor('#EDEDED')
VERDE = colors.HexColor('#15803D')
VERDE_FUNDO = colors.HexColor('#F0FAF3')

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
S_VALOR = ParagraphStyle('valor', fontName='Helvetica', fontSize=8.5,
                         leading=10.5)
S_VALOR_G = ParagraphStyle('valorg', fontName='Helvetica-Bold', fontSize=11,
                           leading=13)
S_CEL = ParagraphStyle('cel', fontName='Helvetica', fontSize=7.5, leading=9)
S_CEL_B = ParagraphStyle('celb', fontName='Helvetica-Bold', fontSize=7.5,
                         leading=9)
S_ENDER = ParagraphStyle('ender', fontName='Helvetica', fontSize=7,
                         leading=8.5, textColor=CINZA_TEXTO)
S_RECEB = ParagraphStyle('receb', fontName='Helvetica', fontSize=6.8,
                         leading=8.5, textColor=VERDE)
S_VAZIO = ParagraphStyle('vazio', fontName='Helvetica-Oblique', fontSize=8,
                         leading=11, alignment=1, textColor=CINZA_BORDA)
S_ASSIN = ParagraphStyle('assin', fontName='Helvetica-Bold', fontSize=8,
                         leading=10, alignment=1)


# ── Formatação ──────────────────────────────────────────────

def dt(valor, fmt='%d/%m/%Y %H:%M'):
    if not valor:
        return '—'
    texto = str(valor).strip()
    try:
        limpo = texto.replace('T', ' ')
        if '+' in limpo[10:]:
            limpo = limpo[:10] + limpo[10:].split('+')[0]
        else:
            idx = limpo.rfind('-')
            if idx > 10:
                limpo = limpo[:idx]
        limpo = limpo.split('.')[0].strip()

        if len(limpo) == 10:
            return datetime.strptime(limpo, '%Y-%m-%d').strftime('%d/%m/%Y')
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


def doc_formatado(v):
    d = ''.join(ch for ch in str(v or '') if ch.isdigit())
    if len(d) == 14:
        return f'{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}'
    if len(d) == 11:
        return f'{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}'
    return str(v or '')


def cep_formatado(v):
    d = ''.join(ch for ch in str(v or '') if ch.isdigit())
    if len(d) == 8:
        return f'{d[:5]}-{d[5:]}'
    return str(v or '')


def escapar(texto):
    """Paragraph interpreta tags: & < > precisam virar entidade."""
    return (str(texto or '')
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;'))


def P(texto, estilo=S_CEL):
    return Paragraph(escapar(texto), estilo)


def imagem_de(b64, largura, altura):
    """Image do ReportLab a partir de base64, ou None."""
    if not b64:
        return None
    try:
        bruto = b64
        if ',' in bruto[:40]:
            bruto = bruto.split(',', 1)[1]
        img = Image(io.BytesIO(base64.b64decode(bruto)))
        prop = img.imageWidth / float(img.imageHeight or 1)
        if largura / altura > prop:
            img.drawHeight = altura
            img.drawWidth = altura * prop
        else:
            img.drawWidth = largura
            img.drawHeight = largura / prop
        return img
    except Exception as err:
        print(f'[romaneio] logo ignorado: {err}', file=sys.stderr)
        return None


# ── Blocos ──────────────────────────────────────────────────

def faixa(titulo):
    t = Table([[Paragraph(titulo, S_FAIXA)]], colWidths=[LARGURA_UTIL])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), CINZA_FAIXA),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return t


def cabecalho(emit, rom):
    """Logo | dados do emitente | número da OC."""
    logo = imagem_de(emit.get('logo_base64'), 30 * mm, 20 * mm)

    centro = [
        Paragraph(escapar(emit.get('razaosocial')
                          or emit.get('nomefantasia') or ''), S_TITULO),
        Spacer(1, 2),
        Paragraph(
            f"CNPJ: {doc_formatado(emit.get('cnpj'))}"
            + (f" | {escapar(emit['email'])}" if emit.get('email') else ''),
            S_SUB),
        Paragraph(escapar(emit.get('endereco') or ''), S_SUB),
    ]

    direita = Table([
        [Paragraph('ROMANEIO Nº', S_ROTULO)],
        [Paragraph(f"<b>{rom.get('numero', '')}</b>", S_VALOR_G)],
    ], colWidths=[30 * mm])
    direita.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.7, CINZA_BORDA),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))

    larguras = ([32 * mm, LARGURA_UTIL - 64 * mm, 32 * mm] if logo
                else [LARGURA_UTIL - 32 * mm, 32 * mm])
    linha = ([logo, centro, direita] if logo else [centro, direita])

    t = Table([linha], colWidths=larguras)
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (0, 0), (0, 0), 'CENTER'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    return t


def campo(rotulo, valor):
    """Célula com rótulo pequeno acima e valor abaixo."""
    return Table(
        [[Paragraph(rotulo, S_ROTULO)],
         [Paragraph(escapar(valor if valor not in (None, '') else '—'), S_VALOR)]],
        style=TableStyle([
            ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
        ]))


def bloco_carga(rom, totais):
    w = LARGURA_UTIL

    linha1 = [
        campo('Placa', rom.get('placa')),
        campo('Veículo', rom.get('veiculo')),
        campo('Motorista', rom.get('motorista')),
        campo('Data de saída', dt(rom.get('data_saida'))),
    ]

    linha2 = [
        campo('Telefone', rom.get('motorista_fone')),
        campo('Distância prevista', rom.get('kmest')),
        campo('Duração prevista', rom.get('duracaoest')),
        campo('Total de entregas', totais.get('entregas')),
    ]

    t = Table([linha1, linha2],
              colWidths=[w * 0.18, w * 0.30, w * 0.30, w * 0.22])
    t.setStyle(TableStyle([
        ('GRID', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
    ]))
    return t


def _celula_entregue(e):
    """
    Entrega concluída: data da assinatura, quem recebeu e o documento.
    Ainda pendente: célula vazia, que com a borda vira o quadrado de
    conferência usado na doca durante o carregamento.

    O gatilho é `assinadodh`, não `checkoutdh`: são momentos
    diferentes, e o dado exibido aqui é o da assinatura.
    """
    if not e.get('assinadodh'):
        return P('')

    linhas = [f"<b>{dt(e['assinadodh'], '%d/%m/%y %H:%M')}</b>"]

    recebedor = (e.get('recebedor') or '').strip()
    if recebedor:
        linhas.append(escapar(recebedor))

    doc = (e.get('recebedor_doc') or '').strip()
    tipo = (e.get('recebedor_tipodoc') or '').strip()
    if doc:
        linhas.append(escapar(f'{tipo} {doc}'.strip()))

    return Paragraph('<br/>'.join(linhas), S_RECEB)


def tabela_entregas(entregas):
    """
    Duas linhas por entrega: a primeira com sequência, nota e
    destinatário; a segunda, recuada, com o endereço completo.
    Endereço em coluna própria ficaria estreito demais para ser
    lido pelo motorista dentro do veículo.
    """
    w = LARGURA_UTIL

    if not entregas:
        return Table([[Paragraph('Nenhuma entrega vinculada a esta carga.', S_VAZIO)]],
                     colWidths=[w],
                     style=TableStyle([
                         ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
                         ('TOPPADDING', (0, 0), (-1, -1), 10),
                         ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
                     ]))

    larguras = [w * 0.06, w * 0.09, w * 0.44, w * 0.11, w * 0.30]

    dados = [[
        P('Seq.', S_CEL_B), P('Nota', S_CEL_B),
        P('Destinatário / Endereço', S_CEL_B),
        P('Valor', S_CEL_B), P('Entregue', S_CEL_B),
    ]]

    estilo = [
        ('BACKGROUND', (0, 0), (-1, 0), CINZA_CLARO),
        ('LINEBELOW', (0, 0), (-1, 0), 0.5, CINZA_BORDA),
        ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ALIGN', (0, 0), (1, -1), 'CENTER'),
        ('ALIGN', (3, 0), (3, -1), 'RIGHT'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]

    linha = 1
    for e in entregas:
        entregue = bool(e.get('assinadodh'))

        # Linha principal
        dados.append([
            P(e.get('seqcarga')),
            P(e.get('numnota')),
            P(e.get('razaosocial'), S_CEL_B),
            P(moeda(e.get('vlrnota'))),
            _celula_entregue(e),
        ])

        # Linha do endereço
        partes = []
        rua = ', '.join(x for x in [e.get('endereco'), e.get('numend')] if x)
        if rua:
            partes.append(rua)
        if e.get('nomebairro'):
            partes.append(e['nomebairro'])

        cidade_uf = '/'.join(x for x in [e.get('cidade'), e.get('estado')] if x)
        if cidade_uf:
            partes.append(cidade_uf)
        if e.get('cep'):
            partes.append(f"CEP {cep_formatado(e['cep'])}")

        dados.append(['', '', P(' · '.join(partes), S_ENDER), '', ''])

        # Junta o par (dados + endereço) numa célula visual só
        estilo.append(('SPAN', (0, linha), (0, linha + 1)))
        estilo.append(('SPAN', (1, linha), (1, linha + 1)))
        estilo.append(('SPAN', (3, linha), (3, linha + 1)))
        estilo.append(('SPAN', (4, linha), (4, linha + 1)))
        estilo.append(('LINEBELOW', (0, linha + 1), (-1, linha + 1),
                       0.5, CINZA_LINHA))

        # A coluna "Entregue" sempre tem borda: com dados vira o
        # comprovante, vazia vira o quadrado de conferência.
        estilo.append(('BOX', (4, linha), (4, linha + 1), 0.5, CINZA_BORDA))
        if entregue:
            estilo.append(('BACKGROUND', (4, linha), (4, linha + 1), VERDE_FUNDO))
            estilo.append(('VALIGN', (4, linha), (4, linha + 1), 'MIDDLE'))
            estilo.append(('LEFTPADDING', (4, linha), (4, linha + 1), 6))

        linha += 2

    t = Table(dados, colWidths=larguras, repeatRows=1)
    t.setStyle(TableStyle(estilo))
    return t


def bloco_totais(totais):
    w = LARGURA_UTIL

    total = totais.get('entregas', 0) or 0
    entregues = totais.get('entregues', 0) or 0
    pendentes = total - entregues

    t = Table([[
        P(f'Entregas: {total}', S_CEL_B),
        P(f'Entregues: {entregues}', S_CEL_B),
        P(f'Pendentes: {pendentes}', S_CEL_B),
        P(f"Valor total: R$ {moeda(totais.get('valor'))}", S_CEL_B),
    ]], colWidths=[w * 0.20, w * 0.20, w * 0.20, w * 0.40])
    t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('BACKGROUND', (0, 0), (-1, -1), CINZA_CLARO),
        ('ALIGN', (3, 0), (3, 0), 'RIGHT'),
        ('TEXTCOLOR', (1, 0), (1, 0), VERDE),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
    ]))
    return t


def bloco_observacao(obs):
    if not obs or not str(obs).strip():
        return None
    t = Table([[P(obs, S_CEL)]], colWidths=[LARGURA_UTIL])
    t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.5, CINZA_BORDA),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
    ]))
    return t


def bloco_assinaturas(rom):
    """Duas assinaturas: quem conferiu a carga e o motorista."""
    w = LARGURA_UTIL
    largura_linha = w * 0.42

    def coluna(titulo, nome):
        linha = Table([['']], colWidths=[largura_linha], rowHeights=[1])
        linha.setStyle(TableStyle([
            ('LINEABOVE', (0, 0), (-1, 0), 0.7, colors.black),
        ]))
        itens = [Spacer(1, 16 * mm), linha, Spacer(1, 3)]
        if nome and nome != '—':
            itens.append(Paragraph(escapar(str(nome).upper()), S_ASSIN))
            itens.append(Spacer(1, 2))
        itens.append(Paragraph(titulo, S_ASSIN))
        return itens

    t = Table([[coluna('Conferente', ''),
                coluna('Motorista', rom.get('motorista'))]],
              colWidths=[w * 0.5, w * 0.5])
    t.setStyle(TableStyle([
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return t


# ── Rodapé ──────────────────────────────────────────────────

def rodape(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica', 6.5)
    canvas.setFillColor(CINZA_BORDA)
    canvas.drawString(15 * mm, 10 * mm,
                      f'Romaneio de carga — emitido em '
                      f'{datetime.now().strftime("%d/%m/%Y %H:%M")}')
    canvas.drawRightString(A4[0] - 15 * mm, 10 * mm, f'Página {doc.page}')
    canvas.restoreState()


# ── Montagem ────────────────────────────────────────────────

def gerar(d):
    buf = io.BytesIO()

    rom = d.get('romaneio') or {}
    totais = d.get('totais') or {}

    doc = BaseDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=12 * mm, bottomMargin=15 * mm,
        title=f"Romaneio {rom.get('numero', '')}",
        author='Entrega Fácil',
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin,
                  doc.width, doc.height, id='corpo')
    doc.addPageTemplates([PageTemplate(id='padrao', frames=[frame],
                                       onPage=rodape)])

    hist = []
    hist.append(cabecalho(d.get('emitente') or {}, rom))
    hist.append(Spacer(1, 8))

    hist.append(faixa('Dados da Carga'))
    hist.append(bloco_carga(rom, totais))
    hist.append(Spacer(1, 8))

    hist.append(faixa('Entregas'))
    hist.append(tabela_entregas(d.get('entregas') or []))
    hist.append(Spacer(1, 4))
    hist.append(bloco_totais(totais))

    obs = bloco_observacao(rom.get('obs'))
    if obs is not None:
        hist.append(Spacer(1, 8))
        hist.append(faixa('Observações'))
        hist.append(obs)

    hist.append(Spacer(1, 16))
    hist.append(bloco_assinaturas(rom))

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
    except Exception:
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(2)

    sys.stdout.buffer.write(pdf)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
