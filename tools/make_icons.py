import sys, os, math
from PIL import Image, ImageDraw, ImageFont
BG=(18,24,29,255); AMBER=(255,176,32,255); TEXT=(233,238,242,255); DIM=(44,56,65,255)
FONT=[p for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf","/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"] if os.path.exists(p)][0]
def glyph(size, scale=1.0, bg=None):
    S=size*4
    im=Image.new("RGBA",(S,S),bg or (0,0,0,0)); d=ImageDraw.Draw(im)
    c=S/2; r=S*0.30*scale; w=S*0.065*scale
    box=[c-r,c-r*0.9-r*0.1,c+r,c+r*1.1-r*0.1]
    box=[c-r,c-r,c+r,c+r]
    d.arc(box,150,390,fill=DIM,width=int(w))
    d.arc(box,150,330,fill=AMBER,width=int(w))
    ang=math.radians(330); d.line([c,c,c+r*0.78*math.cos(ang),c+r*0.78*math.sin(ang)],fill=AMBER,width=int(w*0.55))
    d.ellipse([c-w*0.7,c-w*0.7,c+w*0.7,c+w*0.7],fill=AMBER)
    f=ImageFont.truetype(FONT,int(S*0.15*scale))
    tw=d.textlength("OEE",font=f); d.text((c-tw/2,c+r*0.42),"OEE",font=f,fill=TEXT)
    return im.resize((size,size),Image.LANCZOS)
def rounded(size):
    g=glyph(size,1.0,BG); m=Image.new("L",(size*4,size*4),0)
    ImageDraw.Draw(m).rounded_rectangle([0,0,size*4,size*4],radius=size*0.9,fill=255)
    out=Image.new("RGBA",(size,size),(0,0,0,0)); out.paste(g,(0,0),m.resize((size,size),Image.LANCZOS)); return out
def circle(size):
    g=glyph(size,1.0,BG); m=Image.new("L",(size*4,size*4),0)
    ImageDraw.Draw(m).ellipse([0,0,size*4,size*4],fill=255)
    out=Image.new("RGBA",(size,size),(0,0,0,0)); out.paste(g,(0,0),m.resize((size,size),Image.LANCZOS)); return out
if __name__ == "__main__":
    res = sys.argv[1]
    dens={"mdpi":1,"hdpi":1.5,"xhdpi":2,"xxhdpi":3,"xxxhdpi":4}
    for k,s in dens.items():
        d=f"{res}/mipmap-{k}"
        rounded(int(48*s)).save(f"{d}/ic_launcher.png")
        circle(int(48*s)).save(f"{d}/ic_launcher_round.png")
        glyph(int(108*s),0.72).save(f"{d}/ic_launcher_foreground.png")
    for dname in os.listdir(res):
        if dname.startswith("drawable"):
            p=f"{res}/{dname}/splash.png"
            if os.path.exists(p):
                w,h=Image.open(p).size
                im=Image.new("RGBA",(w,h),BG); g=glyph(int(min(w,h)*0.5),1.0)
                im.paste(g,((w-g.width)//2,(h-g.height)//2),g); im.convert("RGB").save(p)
    glyph(512,1.0,BG).save("tools/icon_preview.png")
