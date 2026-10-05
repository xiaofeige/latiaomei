package stats

import (
	"math"
	"math/bits"
)

// 极简 HyperLogLog：只用来估当日独立访客数。
// 选它而不是存访客表的原因很直接——原始访客数据会一直长，而一个
// 1KB 的寄存器数组就够把 UV 估到 ±3% 以内，并且天然是单向哈希，
// 库里落不下任何能反查出某个访客的东西。
const (
	hllBits = 10           // 2^10 = 1024 个寄存器
	hllSize = 1 << hllBits //
	hllMax  = 55           // 寄存器最大值：64 - hllBits + 1
)

// HLL 是可复用的计数器，非并发安全（外面用锁保护）。
type HLL struct {
	reg [hllSize]uint8
}

// Add 灌入一个 64 位哈希。
func (h *HLL) Add(sum uint64) {
	// 高位做寄存器下标，低位数前导零当作秩。
	idx := sum >> (64 - hllBits)
	w := (sum << hllBits) | (1 << (hllBits - 1)) // 丢掉用掉的高位，补一个哨兵防全零
	r := uint8(64-hllBits-bits.Len64(w)) + 1
	if r > hllMax {
		r = hllMax
	}
	if r > h.reg[idx] {
		h.reg[idx] = r
	}
}

// Merge 把另一份寄存器并进自己（跨重启恢复时用）。
func (h *HLL) Merge(other []byte) {
	if len(other) != hllSize {
		return
	}
	for i, v := range other {
		if v > h.reg[i] {
			h.reg[i] = v
		}
	}
}

// Bytes 导出寄存器，落库。
func (h *HLL) Bytes() []byte {
	out := make([]byte, hllSize)
	copy(out, h.reg[:])
	return out
}

// Cardinality 估算基数：标准 HLL 估计 + 小基数线性计数修正。
func (h *HLL) Cardinality() int64 {
	var sum float64
	zeros := 0
	for _, v := range h.reg {
		sum += 1 / float64(uint64(1)<<v)
		if v == 0 {
			zeros++
		}
	}
	alpha := 0.7213 / (1 + 1.079/float64(hllSize))
	est := alpha * float64(hllSize) * float64(hllSize) / sum
	// 稀疏阶段（本站日常就在这个区间）用线性计数，精度明显更高。
	if est <= 2.5*float64(hllSize) && zeros > 0 {
		return int64(float64(hllSize)*math.Log(float64(hllSize)/float64(zeros)) + 0.5)
	}
	return int64(est + 0.5)
}

// hashKey 把访客指纹压成 64 位。用 FNV-1a 足够：这不是安全场景，
// 只要分布均匀、且不可逆地丢掉 IP 原文即可。
func hashKey(salt, visitor string) uint64 {
	const (
		offset = 14695981039346656037
		prime  = 1099511628211
	)
	h := uint64(offset)
	for i := 0; i < len(salt); i++ {
		h ^= uint64(salt[i])
		h *= prime
	}
	for i := 0; i < len(visitor); i++ {
		h ^= uint64(visitor[i])
		h *= prime
	}
	// 避免退化：不让低 hllBits 位全 0 导致寄存器分布偏斜。
	h ^= h >> 33
	h *= 0xff51afd7ed558ccd
	h ^= h >> 29
	return h
}
