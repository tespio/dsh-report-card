from PIL import Image, ImageDraw
S = 4
def rr(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)
img = Image.new("RGBA", (96*S, 96*S), (0,0,0,0))
d = ImageDraw.Draw(img)
rr(d, (3*S, 3*S, 93*S, 93*S), 21*S, (15, 42, 36, 255))
rr(d, (21*S, 18*S, 75*S, 78*S), 7*S, (233, 245, 240, 255))
rr(d, (31*S, 30*S, 64*S, 34*S), 2*S, (15, 42, 36, 255))
rr(d, (31*S, 43*S, 55*S, 47*S), 2*S, (15, 42, 36, 255))
# check mark
d.line([(31*S, 63*S), (39*S, 71*S), (58*S, 47*S)], fill=(24, 169, 116, 255), width=6*S, joint="curve")
d.ellipse([(33*S, 61*S), (39*S, 67*S)], fill=(24, 169, 116, 255))
img = img.resize((96, 96), Image.LANCZOS)
img.save("assets/icon-96.png")
print("wrote assets/icon-96.png")
