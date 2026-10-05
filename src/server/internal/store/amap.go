package store

import "strings"

// amap_poi 读写：鉴店 skill 的高德到店数据缓存。
// 键归一化（去空格、小写化对中文无意义，只做 Trim），7 天 TTL 由调用方判。

// AmapPOICache 一行缓存。
type AmapPOICache struct {
	Name      string
	Info      string // JSON
	FetchedAt int64
}

// amapKey 归一化缓存键。
func amapKey(city, name string) string {
	return strings.TrimSpace(city) + "|" + strings.Join(strings.Fields(name), "")
}

// GetAmapPOI 查缓存；没有行返回 nil。
func (s *Store) GetAmapPOI(city, name string) (*AmapPOICache, error) {
	row := s.db.QueryRow(`SELECT name, info, fetched_at FROM amap_poi WHERE shop_key=?`, amapKey(city, name))
	var c AmapPOICache
	err := row.Scan(&c.Name, &c.Info, &c.FetchedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// PutAmapPOI 写/覆盖缓存。空结果也要存（Info 置 "{}"），避免 miss 的店反复打外网。
func (s *Store) PutAmapPOI(city, name string, c AmapPOICache) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO amap_poi(shop_key, name, info, fetched_at) VALUES(?,?,?,?)
		ON CONFLICT(shop_key) DO UPDATE SET name=excluded.name, info=excluded.info, fetched_at=excluded.fetched_at`,
		amapKey(city, name), strings.TrimSpace(c.Name), c.Info, c.FetchedAt)
	return err
}
