"""
Writes the picture fixture for the PowerPoint import tests
(src/design/import/fixtures/pictures-8-slides.pptx) with python-pptx: a PNG,
a JPEG and a rotated picture; a cropped picture; a picture placeholder; a
slide background picture; grouped pictures, one group scaled; an SVG picture
with its PNG fallback; a picture-filled rectangle; and an off-center crop.

    python -I scripts/pptx-picture-fixture.py <images dir> <deck.pptx>

Needs python-pptx, Pillow and lxml.
"""
import sys
from pathlib import Path

from lxml import etree
from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.opc.packuri import PackURI
from pptx.util import Inches

inputs = Path(sys.argv[1]); out = Path(sys.argv[2])
inputs.mkdir(parents=True, exist_ok=True)
def bold(size):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", size)
    except OSError:  # Not macOS: Pillow's own font, so the fixture still builds.
        return ImageFont.load_default(size)
font = bold(90)
small = bold(45)

# 800 x 400 PNG: four colored quadrants labeled A B C D; aspect 2:1, so a square cover crop shows B and C halves.
png = Image.new("RGBA", (800, 400), (0, 0, 0, 0))
d = ImageDraw.Draw(png)
for i, (color, label) in enumerate([((220, 38, 38, 255), "A"), ((37, 99, 235, 255), "B"), ((22, 163, 74, 255), "C"), ((234, 179, 8, 255), "D")]):
    d.rectangle([i * 200, 0, i * 200 + 199, 399], fill=color)
    d.text((i * 200 + 70, 150), label, fill=(255, 255, 255, 255), font=font)
d.ellipse([360, 160, 440, 240], fill=(0, 0, 0, 0))  # transparent hole in the middle
png.save(inputs / "quadrants.png")

# 800 x 450 JPEG: a sunset-like gradient with a white circle and a label, used as a full-bleed background.
jpg = Image.new("RGB", (800, 450))
px = jpg.load()
for y in range(450):
    for x in range(800):
        px[x, y] = (int(30 + 200 * y / 450), int(40 + 80 * x / 800), int(160 - 120 * y / 450))
d = ImageDraw.Draw(jpg)
d.ellipse([600, 60, 720, 180], fill=(255, 255, 255))
d.text((40, 380), "JPEG BACKGROUND", fill=(255, 255, 255), font=small)
jpg.save(inputs / "sunset.jpg", quality=80)

# Square PNG logo for the grouped picture and the placeholder.
logo = Image.new("RGB", (300, 300), (15, 23, 43))
d = ImageDraw.Draw(logo)
d.rectangle([30, 30, 270, 270], outline=(234, 88, 12), width=16)
d.text((95, 95), "L", fill=(234, 88, 12), font=font)
logo.save(inputs / "logo.png")

(inputs / "badge.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><circle cx="100" cy="100" r="90" fill="#7c3aed"/><text x="100" y="125" font-size="80" text-anchor="middle" fill="#fff" font-family="Arial">S</text></svg>')
# PNG fallback PowerPoint writes next to an SVG picture.
svgpng = Image.new("RGBA", (200, 200), (0, 0, 0, 0)); d = ImageDraw.Draw(svgpng)
d.ellipse([10, 10, 190, 190], fill=(124, 58, 237, 255)); d.text((70, 50), "S", fill="white", font=font)
svgpng.save(inputs / "badge-fallback.png")

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
A = "{%s}" % NS["a"]; P = "{%s}" % NS["p"]; R = "{%s}" % NS["r"]

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)  # 12192000 x 6858000
blank = prs.slide_layouts[6]

def notes(slide, text): slide.notes_slide.notes_text_frame.text = text

# 1: a PNG and a JPEG picture, plus a rotated copy.
s = prs.slides.add_slide(blank)
s.shapes.add_picture(str(inputs / "quadrants.png"), Inches(1), Inches(1), Inches(4), Inches(2)).name = "Quadrants PNG"
s.shapes.add_picture(str(inputs / "sunset.jpg"), Inches(6), Inches(1), Inches(6.4), Inches(3.6)).name = "Sunset JPEG"
rot = s.shapes.add_picture(str(inputs / "logo.png"), Inches(1), Inches(4.5), Inches(2), Inches(2)); rot.name = "Rotated logo"; rot.rotation = 30
notes(s, "PNG, JPEG and a rotated picture")

# 2: a cropped picture: the middle half of the quadrants (B and C) in a 4 x 4 in box.
s = prs.slides.add_slide(blank)
pic = s.shapes.add_picture(str(inputs / "quadrants.png"), Inches(2), Inches(1.5), Inches(4), Inches(4))
pic.name = "Cropped BC"; pic.crop_left = 0.25; pic.crop_right = 0.25
notes(s, "Cropped picture: only B and C")

# 3: a picture placeholder (Picture with Caption layout); python-pptx crops it to fill.
s = prs.slides.add_slide(prs.slide_layouts[8])
for ph in s.placeholders:
    if ph.placeholder_format.type == 18:  # PICTURE
        ph.insert_picture(str(inputs / "sunset.jpg")).name = "Placeholder picture"
    elif ph.placeholder_format.idx == 0:
        ph.text = "Picture placeholder"
notes(s, "Picture placeholder from the layout")

# 4: a slide background picture (Format Background > Picture fill).
s = prs.slides.add_slide(blank)
_, rid = s.part.get_or_add_image_part(str(inputs / "sunset.jpg"))
cSld = s._element.find(P + "cSld")
bg = etree.fromstring(f'<p:bg xmlns:p="{NS["p"]}" xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}"><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="{rid}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>')
cSld.insert(0, bg)
tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1)); tb.text_frame.text = "Background picture"; tb.name = "Title"
notes(s, "Slide background picture")

# 5: grouped pictures; the second group is scaled to half its child extents.
s = prs.slides.add_slide(blank)
g = s.shapes.add_group_shape(); g.name = "Logo group"
g.shapes.add_picture(str(inputs / "logo.png"), Inches(1), Inches(1), Inches(2), Inches(2)).name = "Grouped logo"
g.shapes.add_picture(str(inputs / "quadrants.png"), Inches(3.5), Inches(1), Inches(4), Inches(2)).name = "Grouped quadrants"
g2 = s.shapes.add_group_shape(); g2.name = "Scaled group"
g2.shapes.add_picture(str(inputs / "logo.png"), Inches(1), Inches(4), Inches(2), Inches(2)).name = "Scaled logo"
xfrm = g2._element.grpSpPr.find(A + "xfrm")
off, ext, choff, chext = (xfrm.find(A + n) for n in ("off", "ext", "chOff", "chExt"))
off.set("x", str(Inches(9))); off.set("y", str(Inches(4)))
ext.set("cx", str(int(chext.get("cx")) // 2)); ext.set("cy", str(int(chext.get("cy")) // 2))
notes(s, "Grouped pictures, one group at half scale")

# 6: an SVG picture with its PNG fallback, as PowerPoint 365 writes it.
s = prs.slides.add_slide(blank)
pic = s.shapes.add_picture(str(inputs / "badge-fallback.png"), Inches(2), Inches(2), Inches(3), Inches(3)); pic.name = "SVG badge"
svg_part = Part(PackURI("/ppt/media/badge1.svg"), "image/svg+xml", s.part.package, (inputs / "badge.svg").read_bytes())
svg_rid = s.part.relate_to(svg_part, RT.IMAGE)
blip = pic._element.blipFill.find(A + "blip")
ext_lst = etree.SubElement(blip, A + "extLst")
ext_el = etree.SubElement(ext_lst, A + "ext", uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}")
svgblip = etree.SubElement(ext_el, "{http://schemas.microsoft.com/office/drawing/2016/SVG/main}svgBlip", nsmap={"asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main"})
svgblip.set(R + "embed", svg_rid)
notes(s, "SVG picture")

# 7: a rectangle filled with a picture (Shape Fill > Picture).
s = prs.slides.add_slide(blank)
rect = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(2), Inches(1), Inches(6), Inches(3.375)); rect.name = "Picture-filled rectangle"
_, rid = s.part.get_or_add_image_part(str(inputs / "sunset.jpg"))
spPr = rect._element.spPr
for kid in list(spPr):
    if kid.tag in (A + "solidFill", A + "noFill", A + "gradFill"): spPr.remove(kid)
blip_fill = etree.fromstring(f'<a:blipFill xmlns:a="{NS["a"]}" xmlns:r="{NS["r"]}" rotWithShape="1"><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>')
spPr.insert(list(spPr).index(spPr.find(A + "prstGeom")) + 1, blip_fill)
notes(s, "Picture fill of a shape")

# 8: an off-center crop no fit expresses: the right half (C and D), top 10% cut, in a box of another shape.
s = prs.slides.add_slide(blank)
pic = s.shapes.add_picture(str(inputs / "quadrants.png"), Inches(2), Inches(1.5), Inches(6), Inches(2.5))
pic.name = "Offset crop CD"; pic.crop_left = 0.5; pic.crop_top = 0.1
notes(s, "Off-center crop")

prs.save(out)
print(out)
