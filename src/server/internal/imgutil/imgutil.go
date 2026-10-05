// Package imgutil 处理上传图片：缩放、重编码、生成缩略图。
//
// 只用 stdlib（jpeg/png/gif），不引 x/image。两个刻意的取舍：
//  1. 原图不保存，统一重编码成"展示尺寸 + 缩略尺寸"两份。手机直出的照片
//     动辄 5MB，几百张就是几百 MB，这里不省磁盘后面就得靠手工清理。
//  2. 重编码顺带丢掉全部 EXIF。探店照片带 GPS 是隐私事故，不该往网上挂。
package imgutil

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"net/http"
)

// 展示图长边上限。1600 对手机全屏够清晰，单张 JPEG 通常 200~400KB。
const (
	MaxLongEdge  = 1600
	ThumbLong    = 480
	MaxPixels    = 60_000_000
	JpegQuality  = 82
	ThumbQuality = 78
)

// Result 是一次处理的产出。
type Result struct {
	Full     []byte // 展示图（jpeg）
	Thumb    []byte // 缩略图（jpeg）
	Width    int
	Height   int
	SrcMime  string
	SrcBytes int
}

// Process 解码、缩放并编码出两份成品。
func Process(data []byte) (*Result, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("imgutil: 空文件")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("imgutil: 读不出图片尺寸（只支持 JPG/PNG/GIF）: %w", err)
	}
	if cfg.Width*cfg.Height > MaxPixels {
		return nil, fmt.Errorf("imgutil: 像素过多 %dx%d，请先裁一下", cfg.Width, cfg.Height)
	}
	switch mime := sniffMime(data); mime {
	case "image/jpeg", "image/png", "image/gif":
	default:
		return nil, fmt.Errorf("imgutil: 不支持的格式 %s（请用 JPG/PNG/GIF）", mime)
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("imgutil: 解码失败: %w", err)
	}
	full := img
	if maxEdge(img.Bounds()) > MaxLongEdge {
		if full, err = scale(img, MaxLongEdge); err != nil {
			return nil, err
		}
	}
	fullBytes, err := encodeJPEG(full, JpegQuality)
	if err != nil {
		return nil, err
	}
	thumb := full
	if maxEdge(full.Bounds()) > ThumbLong {
		if thumb, err = scale(full, ThumbLong); err != nil {
			return nil, err
		}
	}
	thumbBytes, err := encodeJPEG(thumb, ThumbQuality)
	if err != nil {
		return nil, err
	}
	return &Result{
		Full: fullBytes, Thumb: thumbBytes,
		Width: full.Bounds().Dx(), Height: full.Bounds().Dy(),
		SrcMime: sniffMime(data), SrcBytes: len(data),
	}, nil
}

func maxEdge(b image.Rectangle) int {
	if b.Dx() > b.Dy() {
		return b.Dx()
	}
	return b.Dy()
}

// scale 把长边缩到 maxLong。先按 2x2 折半降到 2 倍以内、再做一次精确双线性，
// 这样中间缓冲始终很小，4K 原图也不会一口气吃掉上百 MB 内存。
func scale(src image.Image, maxLong int) (image.Image, error) {
	cur := src
	for maxEdge(cur.Bounds())/2 >= maxLong {
		cur = halve(cur)
	}
	b := cur.Bounds()
	long := maxEdge(b)
	if long <= maxLong {
		return cur, nil
	}
	ratio := float64(maxLong) / float64(long)
	dw := int(float64(b.Dx())*ratio + 0.5)
	dh := int(float64(b.Dy())*ratio + 0.5)
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	return bilinear(cur, dw, dh), nil
}

// halve 整数减半：每个目标像素取 2x2 平均。
func halve(src image.Image) image.Image {
	b := src.Bounds()
	dw, dh := max(1, b.Dx()/2), max(1, b.Dy()/2)
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sum [4]uint32
			var n uint32
			for dy := 0; dy < 2; dy++ {
				for dx := 0; dx < 2; dx++ {
					sx, sy := b.Min.X+x*2+dx, b.Min.Y+y*2+dy
					if sx >= b.Max.X || sy >= b.Max.Y {
						continue
					}
					r, g, bl, a := src.At(sx, sy).RGBA()
					sum[0] += r >> 8
					sum[1] += g >> 8
					sum[2] += bl >> 8
					sum[3] += a >> 8
					n++
				}
			}
			if n == 0 {
				n = 1
			}
			dst.Set(x, y, color.RGBA{
				R: uint8(sum[0] / n), G: uint8(sum[1] / n),
				B: uint8(sum[2] / n), A: uint8(sum[3] / n),
			})
		}
	}
	return dst
}

// bilinear 双线性插值到目标尺寸（只做最后一跳，此时输入已经不大）。
func bilinear(src image.Image, dw, dh int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	xRatio := float64(sw) / float64(dw)
	yRatio := float64(sh) / float64(dh)
	at := func(px, py int) color.Color { return src.At(b.Min.X+px, b.Min.Y+py) }
	for y := 0; y < dh; y++ {
		sy := max(0.0, (float64(y)+0.5)*yRatio-0.5)
		y0 := min(int(sy), sh-1)
		y1 := min(y0+1, sh-1)
		fy := sy - float64(y0)
		for x := 0; x < dw; x++ {
			sx := max(0.0, (float64(x)+0.5)*xRatio-0.5)
			x0 := min(int(sx), sw-1)
			x1 := min(x0+1, sw-1)
			fx := sx - float64(x0)
			dst.Set(x, y, blend(at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1), fx, fy))
		}
	}
	return dst
}

// blend 对四个采样点做双线性加权。
func blend(c00, c10, c01, c11 color.Color, fx, fy float64) color.RGBA {
	chans := func(v00, v10, v01, v11 uint32) uint8 {
		top := float64(v00>>8)*(1-fx) + float64(v10>>8)*fx
		bot := float64(v01>>8)*(1-fx) + float64(v11>>8)*fx
		return uint8(top*(1-fy) + bot*fy)
	}
	r00, g00, b00, a00 := c00.RGBA()
	r10, g10, b10, a10 := c10.RGBA()
	r01, g01, b01, a01 := c01.RGBA()
	r11, g11, b11, a11 := c11.RGBA()
	return color.RGBA{
		R: chans(r00, r10, r01, r11),
		G: chans(g00, g10, g01, g11),
		B: chans(b00, b10, b01, b11),
		A: chans(a00, a10, a01, a11),
	}
}

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("imgutil: 编码 jpeg: %w", err)
	}
	return buf.Bytes(), nil
}

// sniffMime 用 magic 判断真实类型，不信客户端声明的 Content-Type。
func sniffMime(b []byte) string {
	if len(b) >= 4 && string(b[:3]) == "GIF" {
		return "image/gif"
	}
	return http.DetectContentType(b)
}
