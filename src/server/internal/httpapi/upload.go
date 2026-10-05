package httpapi

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"latiaomei/internal/imgutil"
	"latiaomei/internal/store"
)

// hAdminUpload 接收一张图，落盘两份成品（展示图 + 缩略图），原图不留。
// 返回的 path 直接写进点评的 cover/images 字段。
func (s *Server) hAdminUpload(w http.ResponseWriter, r *http.Request) {
	maxBytes := s.cfg.UploadMax
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1<<20)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		s.jsonErr(w, http.StatusBadRequest, fmt.Sprintf("表单解析失败（单图上限 %dMB）", maxBytes>>20))
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "没收到文件，字段名应为 file")
		return
	}
	defer file.Close()
	if hdr.Size > maxBytes {
		s.jsonErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("图片 %dMB 超过上限 %dMB", hdr.Size>>20, maxBytes>>20))
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "读取文件失败")
		return
	}
	res, err := imgutil.Process(data)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}

	sum := sha256.Sum256(append(data, hdr.Filename...))
	now := s.st.Now()
	sub := now.Format("2006/01")
	dir := filepath.Join(s.cfg.UploadDir(), sub)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log500(s, w, err, "建上传目录")
		return
	}
	base := fmt.Sprintf("%x", sum[:8])
	fullRel := "/" + sub + "/" + base + ".jpg"
	thumbRel := "/" + sub + "/" + base + "_s.jpg"

	if err := writePair(filepath.Join(s.cfg.UploadDir(), sub, base+".jpg"),
		filepath.Join(s.cfg.UploadDir(), sub, base+"_s.jpg"), res); err != nil {
		log500(s, w, err, "写文件")
		return
	}

	u := &store.Upload{
		Path: "/uploads" + fullRel, Thumb: "/uploads" + thumbRel,
		Mime: "image/jpeg", Bytes: int64(len(res.Full)), ThumbBytes: int64(len(res.Thumb)),
		SHA: fmt.Sprintf("%x", sum),
	}
	if err := s.st.SaveUpload(u); err != nil {
		log500(s, w, err, "写台账")
		return
	}
	s.uploadCache.invalidate()
	saved := int64(len(res.Full) + len(res.Thumb))
	s.jsonOK(w, map[string]any{
		"saved_bytes": saved,
		"path":        u.Path, "thumb": u.Thumb, "width": res.Width, "height": res.Height,
		"bytes": u.Bytes, "thumb_bytes": u.ThumbBytes,
		"src_mime": res.SrcMime, "src_bytes": int64(res.SrcBytes),
		"saved_note": fmt.Sprintf("原图 %.1fKB → 展示图 %.1fKB + 缩略图 %.1fKB（EXIF 已清除）",
			float64(res.SrcBytes)/1024, float64(len(res.Full))/1024, float64(len(res.Thumb))/1024),
		"upload_id": u.ID, "at": time.Now().Unix(),
	})
}

// writePair 先写临时文件再 rename，避免进程被杀时留下半截图片。
func writePair(fullPath, thumbPath string, res *imgutil.Result) error {
	steps := []struct {
		path string
		data []byte
	}{
		{fullPath, res.Full},
		{thumbPath, res.Thumb},
	}
	for _, st := range steps {
		tmp := st.path + ".tmp"
		if err := os.WriteFile(tmp, st.data, 0o644); err != nil {
			return fmt.Errorf("写 %s: %w", st.path, err)
		}
		if err := os.Rename(tmp, st.path); err != nil {
			os.Remove(tmp)
			return fmt.Errorf("落位 %s: %w", st.path, err)
		}
	}
	return nil
}
