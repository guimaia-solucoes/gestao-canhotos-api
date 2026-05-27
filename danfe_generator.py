"""
DANFE Generator - Gera PDF do DANFE a partir de XML NF-e (versão 4.00)
Uso: python danfe_generator.py <arquivo.xml> [saida.pdf]
"""

import sys
import xml.etree.ElementTree as ET
from io import BytesIO
import re

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.graphics.barcode import code128
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

# Namespace NF-e
NS = {'nfe': 'http://www.portalfiscal.inf.br/nfe'}


def ns(tag):
    return f'{{{NS["nfe"]}}}{tag}'


def get_text(element, path, default=''):
    """Extrai texto de um subelemento, ignorando namespace."""
    if element is None:
        return default
    tags = path.split('/')
    current = element
    for tag in tags:
        found = None
        for child in current:
            local = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if local == tag:
                found = child
                break
        if found is None:
            return default
        current = found
    return current.text or default


def fmt_cnpj(cnpj):
    cnpj = re.sub(r'\D', '', cnpj)
    if len(cnpj) == 14:
        return f'{cnpj[:2]}.{cnpj[2:5]}.{cnpj[5:8]}/{cnpj[8:12]}-{cnpj[12:]}'
    return cnpj


def fmt_cep(cep):
    cep = re.sub(r'\D', '', cep)
    if len(cep) == 8:
        return f'{cep[:5]}-{cep[5:]}'
    return cep


def fmt_fone(fone):
    fone = re.sub(r'\D', '', fone)
    if len(fone) == 13:  # 55 + DDD + número
        fone = fone[2:]
    if len(fone) == 11:
        return f'({fone[:2]}) {fone[2:7]}-{fone[7:]}'
    if len(fone) == 10:
        return f'({fone[:2]}) {fone[2:6]}-{fone[6:]}'
    return fone


def fmt_valor(val):
    try:
        v = float(val)
        return f'{v:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
    except Exception:
        return val


def fmt_data(dt):
    if not dt:
        return ''
    # 2026-05-25T08:10:56-03:00
    dt = dt[:10]
    parts = dt.split('-')
    if len(parts) == 3:
        return f'{parts[2]}/{parts[1]}/{parts[0]}'
    return dt


def fmt_hora(dt):
    if not dt:
        return ''
    if 'T' in dt:
        t = dt.split('T')[1][:8]
        return t
    return ''


def fmt_chave(chave):
    """Formata chave de acesso em blocos de 4"""
    chave = re.sub(r'\D', '', chave)
    return ' '.join([chave[i:i+4] for i in range(0, len(chave), 4)])


def parse_nfe(xml_content):
    """Parse do XML NF-e e retorna dict com todos os dados."""
    if isinstance(xml_content, str):
        xml_content = xml_content.encode('utf-8')

    root = ET.fromstring(xml_content)

    # Encontra NFe e protNFe ignorando namespace
    def find_tag(el, tag):
        for child in el.iter():
            local = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if local == tag:
                return child
        return None

    nfe = find_tag(root, 'NFe')
    infNFe = find_tag(root, 'infNFe')
    protNFe = find_tag(root, 'protNFe')
    infProt = find_tag(root, 'infProt') if protNFe else None

    def g(el, path):
        return get_text(el, path)

    # IDE
    ide = find_tag(infNFe, 'ide')
    emit = find_tag(infNFe, 'emit')
    dest = find_tag(infNFe, 'dest')
    total = find_tag(infNFe, 'total')
    icmstot = find_tag(total, 'ICMSTot') if total else None
    transp = find_tag(infNFe, 'transp')
    vol = find_tag(transp, 'vol') if transp else None
    pag = find_tag(infNFe, 'pag')
    infAdic = find_tag(infNFe, 'infAdic')
    enderEmit = find_tag(emit, 'enderEmit') if emit else None
    enderDest = find_tag(dest, 'enderDest') if dest else None

    # Chave de acesso
    chave = ''
    if infNFe is not None:
        id_attr = infNFe.get('Id', '')
        chave = id_attr.replace('NFe', '')

    # Protocolo
    prot_num = g(infProt, 'nProt') if infProt else ''
    prot_dt = g(infProt, 'dhRecbto') if infProt else ''

    # Produtos
    dets = []
    for child in infNFe:
        local = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if local == 'det':
            prod = find_tag(child, 'prod')
            imp = find_tag(child, 'imposto')
            icms_tag = None
            cst_val = ''
            if imp:
                icms_grp = find_tag(imp, 'ICMS')
                if icms_grp is not None:
                    for ic in icms_grp:
                        icms_tag = ic
                        break
                if icms_tag is not None:
                    cst_val = g(icms_tag, 'CST') or g(icms_tag, 'CSOSN')

            dets.append({
                'nItem': child.get('nItem', ''),
                'cProd': g(prod, 'cProd'),
                'xProd': g(prod, 'xProd'),
                'NCM': g(prod, 'NCM'),
                'CST': cst_val,
                'CFOP': g(prod, 'CFOP'),
                'uCom': g(prod, 'uCom'),
                'qCom': g(prod, 'qCom'),
                'vUnCom': g(prod, 'vUnCom'),
                'vDesc': g(prod, 'vDesc') or '0.00',
                'vProd': g(prod, 'vProd'),
                'vBC': g(icms_tag, 'vBC') if icms_tag else '0.00',
                'vICMS': g(icms_tag, 'vICMS') if icms_tag else '0.00',
                'pICMS': g(icms_tag, 'pICMS') if icms_tag else '0.00',
                'infAdProd': g(find_tag(child, 'infAdProd') or child, 'infAdProd') if find_tag(child, 'infAdProd') is not None else '',
            })
            # infAdProd é direto no det
            infad = find_tag(child, 'infAdProd')
            dets[-1]['infAdProd'] = infad.text if infad is not None and infad.text else ''

    # Duplicatas
    cobr = find_tag(infNFe, 'cobr')
    dups = []
    if cobr:
        for child in cobr:
            local = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if local == 'dup':
                dups.append({
                    'nDup': g(child, 'nDup'),
                    'dVenc': g(child, 'dVenc'),
                    'vDup': g(child, 'vDup'),
                })

    return {
        'chave': chave,
        'natOp': g(ide, 'natOp'),
        'nNF': g(ide, 'nNF'),
        'serie': g(ide, 'serie'),
        'dhEmi': g(ide, 'dhEmi'),
        'dhSaiEnt': g(ide, 'dhSaiEnt'),
        'tpNF': g(ide, 'tpNF'),
        'modFrete': g(transp, 'modFrete') if transp else '9',

        # Emitente
        'emit_cnpj': g(emit, 'CNPJ'),
        'emit_ie': g(emit, 'IE'),
        'emit_nome': g(emit, 'xNome'),
        'emit_fant': g(emit, 'xFant'),
        'emit_lgr': g(enderEmit, 'xLgr'),
        'emit_nro': g(enderEmit, 'nro'),
        'emit_bairro': g(enderEmit, 'xBairro'),
        'emit_mun': g(enderEmit, 'xMun'),
        'emit_uf': g(enderEmit, 'UF'),
        'emit_cep': g(enderEmit, 'CEP'),
        'emit_fone': g(enderEmit, 'fone'),

        # Destinatário
        'dest_cnpj': g(dest, 'CNPJ') or g(dest, 'CPF'),
        'dest_ie': g(dest, 'IE'),
        'dest_nome': g(dest, 'xNome'),
        'dest_email': g(dest, 'email'),
        'dest_lgr': g(enderDest, 'xLgr'),
        'dest_nro': g(enderDest, 'nro'),
        'dest_bairro': g(enderDest, 'xBairro'),
        'dest_mun': g(enderDest, 'xMun'),
        'dest_uf': g(enderDest, 'UF'),
        'dest_cep': g(enderDest, 'CEP'),
        'dest_fone': g(enderDest, 'fone'),

        # Totais
        'vBC': g(icmstot, 'vBC'),
        'vICMS': g(icmstot, 'vICMS'),
        'vBCST': g(icmstot, 'vBCST'),
        'vST': g(icmstot, 'vST'),
        'vProd': g(icmstot, 'vProd'),
        'vFrete': g(icmstot, 'vFrete'),
        'vSeg': g(icmstot, 'vSeg'),
        'vDesc': g(icmstot, 'vDesc'),
        'vIPI': g(icmstot, 'vIPI'),
        'vNF': g(icmstot, 'vNF'),
        'vOutro': g(icmstot, 'vOutro'),

        # Transporte
        'transp_vol_qVol': g(vol, 'qVol') if vol else '',
        'transp_vol_esp': g(vol, 'esp') if vol else '',
        'transp_vol_marca': g(vol, 'marca') if vol else '',
        'transp_vol_nVol': g(vol, 'nVol') if vol else '',
        'transp_vol_pesoB': g(vol, 'pesoB') if vol else '',
        'transp_vol_pesoL': g(vol, 'pesoL') if vol else '',

        # Protocolo
        'prot_num': prot_num,
        'prot_dt': prot_dt,

        # Informações adicionais
        'infCpl': g(infAdic, 'infCpl') if infAdic else '',
        'infFisco': g(infAdic, 'obsFisco') if infAdic else '',

        'dets': dets,
        'dups': dups,
    }


# ─────────────────────────────────────────────
#  RENDERIZAÇÃO DO DANFE
# ─────────────────────────────────────────────

PAGE_W, PAGE_H = A4  # 595.27 x 841.89 pt
MARGIN = 5 * mm
COL_W = PAGE_W - 2 * MARGIN


def draw_rect(c, x, y, w, h, fill=None):
    if fill:
        c.setFillColor(fill)
        c.rect(x, y, w, h, stroke=1, fill=1)
        c.setFillColor(colors.black)
    else:
        c.rect(x, y, w, h, stroke=1, fill=0)


def draw_label(c, x, y, w, h, label, value, label_size=5, value_size=7,
               align='L', bold_val=False, wrap=False):
    """Desenha caixa com rótulo pequeno em cima e valor em baixo."""
    # Rótulo
    c.setFont('Helvetica', label_size)
    c.setFillColor(colors.HexColor('#444444'))
    c.drawString(x + 1, y + h - label_size - 0.5, label.upper())
    c.setFillColor(colors.black)

    # Valor
    font = 'Helvetica-Bold' if bold_val else 'Helvetica'
    c.setFont(font, value_size)
    text = str(value)

    if wrap:
        # Quebra texto em múltiplas linhas
        style = ParagraphStyle('s', fontName=font, fontSize=value_size,
                               leading=value_size + 1, alignment=TA_LEFT)
        p = Paragraph(text, style)
        p.wrapOn(c, w - 2, h - label_size - 3)
        p.drawOn(c, x + 1, y + 1)
    else:
        if align == 'C':
            c.drawCentredString(x + w / 2, y + 2, text)
        elif align == 'R':
            c.drawRightString(x + w - 1, y + 2, text)
        else:
            # Trunca se muito longo
            while c.stringWidth(text, font, value_size) > w - 3 and len(text) > 1:
                text = text[:-1]
            c.drawString(x + 1, y + 2, text)


def draw_header_box(c, x, y, w, h, text, font_size=6, fill=colors.HexColor('#E8E8E8')):
    draw_rect(c, x, y, w, h, fill=fill)
    c.setFont('Helvetica-Bold', font_size)
    c.setFillColor(colors.black)
    c.drawCentredString(x + w / 2, y + h / 2 - font_size / 2 + 1, text)


def generate_danfe(xml_content, output_path=None):
    """Gera o DANFE a partir do XML. Retorna bytes do PDF."""
    d = parse_nfe(xml_content)

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)

    items_per_page = 13  # itens por página na tabela de produtos
    total_items = len(d['dets'])
    total_pages = max(1, -(-total_items // items_per_page))  # ceil division

    for page_num in range(total_pages):
        items_this_page = d['dets'][page_num * items_per_page:(page_num + 1) * items_per_page]
        _draw_page(c, d, items_this_page, page_num + 1, total_pages)
        if page_num < total_pages - 1:
            c.showPage()

    c.save()
    pdf_bytes = buf.getvalue()

    if output_path:
        with open(output_path, 'wb') as f:
            f.write(pdf_bytes)

    return pdf_bytes


def _draw_page(c, d, items, page_num, total_pages):
    """Desenha uma página do DANFE."""
    x0 = MARGIN
    # Começa pelo topo
    y = PAGE_H - MARGIN

    row_h = 7 * mm  # altura padrão de linha

    # ── CANHOTO ─────────────────────────────────────────────────
    canhoto_h = 18 * mm
    canhoto_y = y - canhoto_h
    draw_rect(c, x0, canhoto_y, COL_W, canhoto_h)

    # Linha tracejada interna
    c.setDash(3, 3)
    c.line(x0, canhoto_y + canhoto_h - 5 * mm, x0 + COL_W, canhoto_y + canhoto_h - 5 * mm)
    c.setDash()

    c.setFont('Helvetica-Bold', 7)
    c.drawString(x0 + 2, canhoto_y + canhoto_h - 4 * mm,
                 'RECEBEMOS DE ' + d['emit_nome'].upper() + ' OS PRODUTOS CONSTANTES DA NOTA FISCAL INDICADA AO LADO')

    c.setFont('Helvetica', 6)
    c.drawString(x0 + 2, canhoto_y + 7, 'DATA DE RECEBIMENTO')
    c.line(x0 + 35 * mm, canhoto_y + 3, x0 + 35 * mm, canhoto_y + 12)
    c.drawString(x0 + 36 * mm, canhoto_y + 7, 'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR')

    # NF no canhoto (lado direito)
    cx2 = x0 + COL_W - 35 * mm
    c.setFont('Helvetica-Bold', 7)
    c.drawString(cx2, canhoto_y + 14, f'NF-e')
    c.setFont('Helvetica', 7)
    c.drawString(cx2, canhoto_y + 8, f'N. {d["nNF"]}')
    c.drawString(cx2, canhoto_y + 2, f'SÉRIE {d["serie"]}')

    y = canhoto_y - 1 * mm

    # ── BLOCO EMITENTE + DANFE + CHAVE ───────────────────────────
    block_h = 35 * mm
    block_y = y - block_h

    # Coluna emitente (esquerda ~45%)
    emit_w = COL_W * 0.45
    draw_rect(c, x0, block_y, emit_w, block_h)

    # Nome emitente
    c.setFont('Helvetica-Bold', 9)
    emit_x_center = x0 + emit_w / 2
    c.drawCentredString(emit_x_center, block_y + block_h - 8, d['emit_nome'])

    c.setFont('Helvetica', 6.5)
    end_emit = (f"{d['emit_lgr']}, {d['emit_nro']} - {d['emit_bairro']} - "
                f"{d['emit_mun']}-{d['emit_uf']} - CEP: {fmt_cep(d['emit_cep'])}")
    # Quebra endereço se muito longo
    max_w = emit_w - 4
    while c.stringWidth(end_emit, 'Helvetica', 6.5) > max_w:
        end_emit = end_emit[:-1]
    c.drawCentredString(emit_x_center, block_y + block_h - 16, end_emit)

    if d['emit_fone']:
        c.drawCentredString(emit_x_center, block_y + block_h - 23,
                            f'Fone: {fmt_fone(d["emit_fone"])}  CEP: {fmt_cep(d["emit_cep"])}')

    # Coluna DANFE (centro ~30%)
    danfe_w = COL_W * 0.30
    danfe_x = x0 + emit_w
    draw_rect(c, danfe_x, block_y, danfe_w, block_h)

    c.setFont('Helvetica-Bold', 14)
    c.drawCentredString(danfe_x + danfe_w / 2, block_y + block_h - 14, 'DANFE')
    c.setFont('Helvetica', 6)
    c.drawCentredString(danfe_x + danfe_w / 2, block_y + block_h - 21,
                        'Documento Auxiliar da Nota')
    c.drawCentredString(danfe_x + danfe_w / 2, block_y + block_h - 27,
                        'Fiscal Eletrônica')

    # Entrada/Saída
    tp = '0 - ENTRADA' if d['tpNF'] == '0' else '1 - SAÍDA'
    c.setFont('Helvetica', 6)
    c.drawString(danfe_x + 2, block_y + block_h - 35, '0 - ENTRADA')
    c.drawString(danfe_x + 2, block_y + block_h - 41, '1 - SAÍDA')

    # Quadrado com tipo
    sq_x = danfe_x + danfe_w - 12
    sq_y = block_y + block_h - 42
    c.rect(sq_x, sq_y, 9, 9, stroke=1, fill=0)
    c.setFont('Helvetica-Bold', 8)
    c.drawCentredString(sq_x + 4.5, sq_y + 1.5, d['tpNF'])

    # Nº NF e Série
    c.setFont('Helvetica-Bold', 9)
    c.drawCentredString(danfe_x + danfe_w / 2, block_y + 22,
                        f'N. {d["nNF"]}')
    c.setFont('Helvetica', 7)
    c.drawCentredString(danfe_x + danfe_w / 2, block_y + 14,
                        f'SÉRIE {d["serie"]}')
    c.setFont('Helvetica', 6)
    c.drawCentredString(danfe_x + danfe_w / 2, block_y + 7,
                        f'FOLHA {page_num}/{total_pages}')

    # Coluna chave + código de barras (direita ~25%)
    chave_w = COL_W - emit_w - danfe_w
    chave_x = danfe_x + danfe_w
    draw_rect(c, chave_x, block_y, chave_w, block_h)

    c.setFont('Helvetica', 5.5)
    c.drawCentredString(chave_x + chave_w / 2, block_y + block_h - 7, 'CHAVE DE ACESSO')

    chave_fmt = fmt_chave(d['chave'])
    c.setFont('Helvetica-Bold', 6)
    # Divide em 2 linhas de ~22 chars
    mid = len(chave_fmt) // 2
    # Garante quebra em espaço
    split_at = chave_fmt.rfind(' ', 0, mid + 5)
    linha1 = chave_fmt[:split_at].strip()
    linha2 = chave_fmt[split_at:].strip()
    c.drawCentredString(chave_x + chave_w / 2, block_y + block_h - 15, linha1)
    c.drawCentredString(chave_x + chave_w / 2, block_y + block_h - 22, linha2)

    # Código de barras (Code128)
    try:
        barcode = code128.Code128(d['chave'], barWidth=0.6, barHeight=12 * mm,
                                  humanReadable=False)
        barcode.drawOn(c, chave_x + 2, block_y + 6)
    except Exception:
        pass

    # Consulta
    c.setFont('Helvetica', 5)
    consul = 'Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora'
    c.drawCentredString(chave_x + chave_w / 2, block_y + 3, consul[:80])

    y = block_y - 0.5 * mm

    # ── NATUREZA DA OPERAÇÃO + IE + CNPJ ─────────────────────────
    row1_h = 7 * mm
    row1_y = y - row1_h

    nat_w = COL_W * 0.55
    ie_w = COL_W * 0.20
    cnpj_w = COL_W - nat_w - ie_w

    draw_rect(c, x0, row1_y, nat_w, row1_h)
    draw_label(c, x0, row1_y, nat_w, row1_h, 'NATUREZA DA OPERAÇÃO', d['natOp'])

    draw_rect(c, x0 + nat_w, row1_y, ie_w, row1_h)
    draw_label(c, x0 + nat_w, row1_y, ie_w, row1_h, 'INSCRIÇÃO ESTADUAL', d['emit_ie'])

    draw_rect(c, x0 + nat_w + ie_w, row1_y, cnpj_w, row1_h)
    draw_label(c, x0 + nat_w + ie_w, row1_y, cnpj_w, row1_h, 'CNPJ', fmt_cnpj(d['emit_cnpj']))

    # Protocolo de autorização
    prot_h = 6 * mm
    prot_y = row1_y - prot_h
    draw_rect(c, x0, prot_y, COL_W, prot_h)
    prot_text = f'PROTOCOLO DE AUTORIZAÇÃO DE USO   {d["prot_num"]}   {fmt_data(d["prot_dt"])} {fmt_hora(d["prot_dt"])}'
    draw_label(c, x0, prot_y, COL_W, prot_h, 'PROTOCOLO DE AUTORIZAÇÃO DE USO', prot_text.replace('PROTOCOLO DE AUTORIZAÇÃO DE USO   ', ''))

    y = prot_y - 0.5 * mm

    # ── DESTINATÁRIO ─────────────────────────────────────────────
    # Título
    dest_title_h = 4 * mm
    dest_title_y = y - dest_title_h
    draw_header_box(c, x0, dest_title_y, COL_W, dest_title_h, 'DESTINATÁRIO / REMETENTE')
    y = dest_title_y

    # Linha: Nome | CNPJ/CPF | Data Emissão
    r_h = 7 * mm
    r_y = y - r_h
    nm_w = COL_W * 0.55
    cnpj_d_w = COL_W * 0.25
    dt_w = COL_W - nm_w - cnpj_d_w

    draw_rect(c, x0, r_y, nm_w, r_h)
    draw_label(c, x0, r_y, nm_w, r_h, 'NOME / RAZÃO SOCIAL', d['dest_nome'])
    draw_rect(c, x0 + nm_w, r_y, cnpj_d_w, r_h)
    draw_label(c, x0 + nm_w, r_y, cnpj_d_w, r_h, 'CNPJ / CPF', fmt_cnpj(d['dest_cnpj']))
    draw_rect(c, x0 + nm_w + cnpj_d_w, r_y, dt_w, r_h)
    draw_label(c, x0 + nm_w + cnpj_d_w, r_y, dt_w, r_h, 'DATA DA EMISSÃO', fmt_data(d['dhEmi']))

    # Linha: Endereço | Bairro | CEP | Data Entrada/Saída
    r2_h = 7 * mm
    r2_y = r_y - r2_h
    end_w = COL_W * 0.40
    bairro_w = COL_W * 0.20
    cep_w = COL_W * 0.15
    dte_w = COL_W - end_w - bairro_w - cep_w

    end_dest = f"{d['dest_lgr']}, {d['dest_nro']}"
    draw_rect(c, x0, r2_y, end_w, r2_h)
    draw_label(c, x0, r2_y, end_w, r2_h, 'ENDEREÇO', end_dest)
    draw_rect(c, x0 + end_w, r2_y, bairro_w, r2_h)
    draw_label(c, x0 + end_w, r2_y, bairro_w, r2_h, 'BAIRRO / DISTRITO', d['dest_bairro'])
    draw_rect(c, x0 + end_w + bairro_w, r2_y, cep_w, r2_h)
    draw_label(c, x0 + end_w + bairro_w, r2_y, cep_w, r2_h, 'CEP', fmt_cep(d['dest_cep']))
    draw_rect(c, x0 + end_w + bairro_w + cep_w, r2_y, dte_w, r2_h)
    draw_label(c, x0 + end_w + bairro_w + cep_w, r2_y, dte_w, r2_h, 'DATA ENTRADA/SAÍDA', fmt_data(d['dhSaiEnt']))

    # Linha: Município | UF | IE | Fone | Hora S/E
    r3_h = 7 * mm
    r3_y = r2_y - r3_h
    mun_w = COL_W * 0.30
    uf_w = COL_W * 0.06
    ied_w = COL_W * 0.20
    fone_w = COL_W * 0.20
    hora_w = COL_W - mun_w - uf_w - ied_w - fone_w

    draw_rect(c, x0, r3_y, mun_w, r3_h)
    draw_label(c, x0, r3_y, mun_w, r3_h, 'MUNICÍPIO', d['dest_mun'])
    draw_rect(c, x0 + mun_w, r3_y, uf_w, r3_h)
    draw_label(c, x0 + mun_w, r3_y, uf_w, r3_h, 'UF', d['dest_uf'])
    draw_rect(c, x0 + mun_w + uf_w, r3_y, ied_w, r3_h)
    draw_label(c, x0 + mun_w + uf_w, r3_y, ied_w, r3_h, 'INSCRIÇÃO ESTADUAL', d['dest_ie'])
    draw_rect(c, x0 + mun_w + uf_w + ied_w, r3_y, fone_w, r3_h)
    draw_label(c, x0 + mun_w + uf_w + ied_w, r3_y, fone_w, r3_h, 'FONE / FAX', fmt_fone(d['dest_fone']))
    draw_rect(c, x0 + mun_w + uf_w + ied_w + fone_w, r3_y, hora_w, r3_h)
    draw_label(c, x0 + mun_w + uf_w + ied_w + fone_w, r3_y, hora_w, r3_h, 'HORA DA SAÍDA', fmt_hora(d['dhSaiEnt']))

    y = r3_y - 0.5 * mm

    # ── CÁLCULO DO IMPOSTO ───────────────────────────────────────
    imp_title_h = 4 * mm
    imp_title_y = y - imp_title_h
    draw_header_box(c, x0, imp_title_y, COL_W, imp_title_h, 'CÁLCULO DO IMPOSTO')
    y = imp_title_y

    imp_h = 7 * mm
    imp_y = y - imp_h
    cols_imp = [
        ('BASE DE CÁLCULO DO ICMS', fmt_valor(d['vBC']), COL_W * 0.15),
        ('VALOR DO ICMS', fmt_valor(d['vICMS']), COL_W * 0.12),
        ('BASE DE CÁLCULO DO ICMS ST', fmt_valor(d['vBCST']), COL_W * 0.16),
        ('VALOR DO ICMS ST', fmt_valor(d['vST']), COL_W * 0.12),
        ('VALOR TOTAL DOS PRODUTOS', fmt_valor(d['vProd']), COL_W * 0.20),
        ('VALOR TOTAL DA NOTA', fmt_valor(d['vNF']), COL_W - (COL_W * 0.75)),
    ]
    cx = x0
    for label, val, w in cols_imp:
        draw_rect(c, cx, imp_y, w, imp_h)
        draw_label(c, cx, imp_y, w, imp_h, label, val, align='R')
        cx += w

    imp2_h = 7 * mm
    imp2_y = imp_y - imp2_h
    rem = COL_W / 6
    cols_imp2 = [
        ('VALOR DO FRETE', fmt_valor(d['vFrete']), rem),
        ('VALOR DO SEGURO', fmt_valor(d['vSeg']), rem),
        ('DESCONTO', fmt_valor(d['vDesc']), rem),
        ('OUTRAS DESPESAS ACESSÓRIAS', fmt_valor(d['vOutro']), rem),
        ('VALOR DO IPI', fmt_valor(d['vIPI']), rem),
        ('VALOR DO IPI DEVOL.', '0,00', COL_W - rem * 5),
    ]
    cx = x0
    for label, val, w in cols_imp2:
        draw_rect(c, cx, imp2_y, w, imp2_h)
        draw_label(c, cx, imp2_y, w, imp2_h, label, val, align='R')
        cx += w

    y = imp2_y - 0.5 * mm

    # ── TRANSPORTADOR ────────────────────────────────────────────
    transp_title_h = 4 * mm
    transp_title_y = y - transp_title_h
    draw_header_box(c, x0, transp_title_y, COL_W, transp_title_h, 'TRANSPORTADOR / VOLUMES TRANSPORTADOS')
    y = transp_title_y

    mf_map = {'0': '0 - Emitente', '1': '1 - Dest/Rem', '2': '2 - Terceiros', '9': '9 - Sem frete'}
    mod_frete = mf_map.get(d['modFrete'], d['modFrete'])

    tr_h = 7 * mm
    tr_y = y - tr_h
    tr_cols = [
        ('RAZÃO SOCIAL', '', COL_W * 0.35),
        ('FRETE POR CONTA', mod_frete, COL_W * 0.15),
        ('CÓDIGO ANTT', '', COL_W * 0.12),
        ('PLACA DO VEÍCULO', '', COL_W * 0.13),
        ('UF', '', COL_W * 0.05),
        ('CNPJ/CPF', '', COL_W - (COL_W * 0.80)),
    ]
    cx = x0
    for label, val, w in tr_cols:
        draw_rect(c, cx, tr_y, w, tr_h)
        draw_label(c, cx, tr_y, w, tr_h, label, val)
        cx += w

    tr2_h = 7 * mm
    tr2_y = tr_y - tr2_h
    tr2_cols = [
        ('ENDEREÇO', '', COL_W * 0.40),
        ('MUNICÍPIO', '', COL_W * 0.25),
        ('UF', '', COL_W * 0.05),
        ('INSCRIÇÃO ESTADUAL', '', COL_W - (COL_W * 0.70)),
    ]
    cx = x0
    for label, val, w in tr2_cols:
        draw_rect(c, cx, tr2_y, w, tr2_h)
        draw_label(c, cx, tr2_y, w, tr2_h, label, val)
        cx += w

    tr3_h = 7 * mm
    tr3_y = tr2_y - tr3_h
    tr3_cols = [
        ('QUANTIDADE', d['transp_vol_qVol'], COL_W * 0.15),
        ('ESPÉCIE', d['transp_vol_esp'], COL_W * 0.15),
        ('MARCA', d['transp_vol_marca'], COL_W * 0.20),
        ('NÚMERO', d['transp_vol_nVol'], COL_W * 0.15),
        ('PESO BRUTO', d['transp_vol_pesoB'], COL_W * 0.175),
        ('PESO LÍQUIDO', d['transp_vol_pesoL'], COL_W - (COL_W * 0.825)),
    ]
    cx = x0
    for label, val, w in tr3_cols:
        draw_rect(c, cx, tr3_y, w, tr3_h)
        draw_label(c, cx, tr3_y, w, tr3_h, label, val)
        cx += w

    y = tr3_y - 0.5 * mm

    # ── DADOS DOS PRODUTOS ───────────────────────────────────────
    prod_title_h = 4 * mm
    prod_title_y = y - prod_title_h
    draw_header_box(c, x0, prod_title_y, COL_W, prod_title_h, 'DADOS DOS PRODUTOS / SERVIÇOS')
    y = prod_title_y

    # Cabeçalho da tabela
    prod_cols = [
        ('CÓD.\nPROD', 0.07),
        ('DESCRIÇÃO DOS PRODUTOS/SERVIÇOS', 0.32),
        ('NCM/SH', 0.07),
        ('CST', 0.04),
        ('CFOP', 0.05),
        ('UN.', 0.04),
        ('QUANT.', 0.07),
        ('V. UNITÁRIO', 0.08),
        ('V. DESC.', 0.07),
        ('V. TOTAL', 0.09),
        ('BC ICMS', 0.07),
        ('V. ICMS', 0.07),
    ]
    # Ajusta última coluna
    total_pct = sum(p for _, p in prod_cols)
    prod_cols[-1] = (prod_cols[-1][0], prod_cols[-1][1] + (1.0 - total_pct))

    hdr_h = 8 * mm
    hdr_y = y - hdr_h
    draw_rect(c, x0, hdr_y, COL_W, hdr_h, fill=colors.HexColor('#E8E8E8'))
    cx = x0
    for lbl, pct in prod_cols:
        w = COL_W * pct
        c.setFont('Helvetica-Bold', 5)
        # Quebra label em linhas
        lines = lbl.split('\n')
        ty = hdr_y + hdr_h / 2 + (len(lines) - 1) * 2.5
        for line in lines:
            c.drawCentredString(cx + w / 2, ty, line)
            ty -= 5
        c.line(cx + w, hdr_y, cx + w, hdr_y + hdr_h)
        cx += w

    y = hdr_y

    # Linhas de produto
    item_h = 6.5 * mm
    for item in items:
        item_y = y - item_h
        draw_rect(c, x0, item_y, COL_W, item_h)
        cx = x0
        vals = [
            item['cProd'],
            item['xProd'] + (' | ' + item['infAdProd'] if item['infAdProd'] else ''),
            item['NCM'],
            item['CST'],
            item['CFOP'],
            item['uCom'],
            item['qCom'],
            fmt_valor(item['vUnCom']),
            fmt_valor(item['vDesc']),
            fmt_valor(item['vProd']),
            fmt_valor(item['vBC']),
            fmt_valor(item['vICMS']),
        ]
        for (lbl, pct), val in zip(prod_cols, vals):
            w = COL_W * pct
            c.line(cx + w, item_y, cx + w, item_y + item_h)
            c.setFont('Helvetica', 5.5)
            # Trunca
            text = str(val)
            while c.stringWidth(text, 'Helvetica', 5.5) > w - 2 and len(text) > 1:
                text = text[:-1]
            if lbl in ('V. TOTAL', 'V. UNITÁRIO', 'V. DESC.', 'BC ICMS', 'V. ICMS',
                        'QUANT.'):
                c.drawRightString(cx + w - 1, item_y + 2, text)
            elif lbl == 'CÓD.\nPROD':
                c.drawCentredString(cx + w / 2, item_y + 2, text)
            else:
                c.drawString(cx + 1, item_y + 2, text)
            cx += w
        y = item_y

    y -= 0.5 * mm

    # ── CÁLCULO DO ISSQN ─────────────────────────────────────────
    issqn_title_h = 4 * mm
    issqn_title_y = y - issqn_title_h
    draw_header_box(c, x0, issqn_title_y, COL_W, issqn_title_h, 'CÁLCULO DO ISSQN')
    y = issqn_title_y

    issqn_h = 7 * mm
    issqn_y = y - issqn_h
    issqn_cols = [
        ('INSCRIÇÃO MUNICIPAL', '', 0.25),
        ('VALOR TOTAL DOS SERVIÇOS', '0,00', 0.25),
        ('BASE DE CÁLCULO DE ISSQN', '0,00', 0.25),
        ('VALOR DO ISSQN', '0,00', 0.25),
    ]
    cx = x0
    for lbl, val, pct in issqn_cols:
        w = COL_W * pct
        draw_rect(c, cx, issqn_y, w, issqn_h)
        draw_label(c, cx, issqn_y, w, issqn_h, lbl, val)
        cx += w

    y = issqn_y - 0.5 * mm

    # ── DADOS ADICIONAIS ──────────────────────────────────────────
    if page_num == total_pages:  # Só na última página
        addt_title_h = 4 * mm
        addt_title_y = y - addt_title_h
        draw_header_box(c, x0, addt_title_y, COL_W, addt_title_h, 'DADOS ADICIONAIS')
        y = addt_title_y

        addt_h = max(18 * mm, PAGE_H * 0.08)
        addt_y = y - addt_h

        info_w = COL_W * 0.65
        fisco_w = COL_W - info_w

        draw_rect(c, x0, addt_y, info_w, addt_h)
        draw_rect(c, x0 + info_w, addt_y, fisco_w, addt_h)

        c.setFont('Helvetica', 5)
        c.drawString(x0 + 1, addt_y + addt_h - 6, 'INFORMAÇÕES COMPLEMENTARES')
        c.drawString(x0 + info_w + 1, addt_y + addt_h - 6, 'RESERVADO AO FISCO')

        # Texto informações complementares
        style = ParagraphStyle('inf', fontName='Helvetica', fontSize=5.5,
                               leading=7, alignment=TA_LEFT)
        p = Paragraph(d['infCpl'].replace('|', '<br/>'), style)
        p.wrapOn(c, info_w - 4, addt_h - 10)
        p.drawOn(c, x0 + 2, addt_y + 2)

    y -= 0.5 * mm

    # ── DUPLICATAS (se houver) ────────────────────────────────────
    if d['dups'] and page_num == total_pages:
        fat_title_h = 4 * mm
        fat_y = y - fat_title_h
        draw_header_box(c, x0, fat_y, COL_W, fat_title_h, 'FATURA / DUPLICATA')
        y = fat_y

        dup_h = 7 * mm
        dup_y = y - dup_h
        dup_w = COL_W / min(len(d['dups']), 6)
        cx = x0
        for i, dup in enumerate(d['dups'][:6]):
            draw_rect(c, cx, dup_y, dup_w, dup_h)
            draw_label(c, cx, dup_y, dup_w, dup_h,
                       f'NÚMERO: {dup["nDup"]}',
                       f'VENC: {fmt_data(dup["dVenc"])}  R$ {fmt_valor(dup["vDup"])}',
                       label_size=5, value_size=6)
            cx += dup_w
        y = dup_y


# ─────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────

if __name__ == '__main__':
    xml_file = sys.argv[1] if len(sys.argv) > 1 else '/mnt/user-data/uploads/35260571714505000166550010000268451114606416.xml'
    out_file = sys.argv[2] if len(sys.argv) > 2 else '/mnt/user-data/outputs/danfe_output.pdf'

    with open(xml_file, 'rb') as f:
        xml_content = f.read()

    pdf = generate_danfe(xml_content, out_file)
    print(f'DANFE gerado: {out_file} ({len(pdf)} bytes)')
