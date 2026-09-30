# Spec: Landing Page — Intelegensia Scholarship Funding (ISF)

## Objective
Landing page satu halaman (single page) untuk program beasiswa **Intelegensia Scholarship Funding**,
ditujukan bagi mahasiswa berprestasi yang mencari pendanaan kuliah.

**Target pengguna:** mahasiswa aktif S1/D4 (dan calon mahasiswa) berprestasi akademik/non-akademik.

**Tujuan halaman:** meyakinkan pengunjung bahwa ISF layak dilamar, lalu mengarahkan ke tombol
"Daftar Sekarang" (CTA). Sukses = pengunjung memahami manfaat, syarat, jadwal, dan cara daftar
tanpa perlu membuka halaman lain.

### Bagian halaman (urutan dari atas)
1. **Navbar** — logo teks "ISF", link anchor ke tiap section, tombol CTA.
2. **Hero** — heading besar + sub-heading + foto mahasiswa (sumber online, lisensi bebas: Unsplash) + 2 tombol (Daftar, Pelajari).
3. **Tentang Beasiswa** — deskripsi singkat untuk siapa beasiswa ini.
4. **3 Value Point** — kartu: Pendanaan Penuh, Mentoring & Jaringan, Pengembangan Karier.
5. **Quote** — kutipan inspiratif dari alumni/pendiri (blok quote besar).
6. **Schedule / Timeline** — 4–5 tahap: Pendaftaran, Seleksi Berkas, Wawancara, Pengumuman, Onboarding.
7. **Cara Apply** — 4 langkah bernomor.
8. **Informasi Beasiswa** — syarat, cakupan dana, FAQ singkat (accordion).
9. **CTA penutup + Footer** — kontak, sosial media, copyright.

### Bahasa & konten
- Bahasa Indonesia.
- Konten berupa **placeholder realistis** (nama, tanggal, nominal fiktif) — mudah diganti nanti.
- Foto dari Unsplash via URL langsung (tidak diunduh ke repo).

## Tech Stack
- HTML5 semantik, CSS3 (custom properties, Grid/Flex), Vanilla JavaScript (ES2020+).
- **Tanpa framework, tanpa build step, tanpa dependency npm.**
- Font: Google Fonts (satu display serif + satu sans body).
- Ikon: inline SVG.

## Palet Warna
Dominan **biru dongker (dark navy)**, aksen **krem** dan **kuning**.

| Token            | Hex       | Peran                                   |
|------------------|-----------|-----------------------------------------|
| `--navy-900`     | `#0B1B3A` | Background utama, hero, footer          |
| `--navy-800`     | `#12274F` | Background section sekunder / kartu     |
| `--navy-700`     | `#1C3666` | Border, hover state, garis timeline     |
| `--navy-500`     | `#2F4F8F` | Elemen dekoratif, link muted            |
| `--cream-100`    | `#F6F1E7` | Teks utama di atas navy, section terang |
| `--cream-200`    | `#EBE3D3` | Background kartu di section terang      |
| `--cream-400`    | `#C9BDA5` | Teks sekunder / muted                   |
| `--gold-500`     | `#F2C14E` | Tombol CTA, highlight, angka langkah    |
| `--gold-600`     | `#D9A62E` | Hover tombol CTA                        |
| `--gold-300`     | `#F8DB8C` | Aksen tipis, underline heading          |

Aturan: navy ≈ 60%, krem ≈ 30%, kuning ≈ 10% (hanya untuk CTA & aksen).
Kontras teks harus memenuhi WCAG AA (krem di atas navy-900 ≈ 13:1; navy-900 di atas gold-500 ≈ 9:1).

## Commands
Tidak ada build step. Untuk preview lokal:
```
Dev:  python3 -m http.server 8080      # buka http://localhost:8080
Lint: npx --yes htmlhint index.html    # opsional, validasi HTML
```

## Project Structure
```
web-isf/
├── index.html        → markup semua section
├── css/
│   └── style.css     → tokens, reset, layout, komponen, responsive
├── js/
│   └── main.js       → nav mobile toggle, accordion FAQ, scroll reveal, smooth scroll
├── assets/
│   └── favicon.svg   → ikon tab
└── SPEC.md
```

## Code Style
- HTML: elemen semantik (`header`, `nav`, `main`, `section`, `article`, `footer`), setiap section punya `id` dan `aria-labelledby`.
- CSS: kebab-case, BEM ringan (`.card`, `.card__title`, `.card--featured`), tokens di `:root`, mobile-first dengan `@media (min-width: …)`.
- JS: `const`/`let`, fungsi kecil, tanpa library, event delegation, semua efek visual menghormati `prefers-reduced-motion`.

Contoh:
```css
:root {
  --navy-900: #0B1B3A;
  --cream-100: #F6F1E7;
  --gold-500: #F2C14E;
  --space-4: 1rem;
}
.btn--primary {
  background: var(--gold-500);
  color: var(--navy-900);
  border-radius: 999px;
  padding: 0.85rem 1.75rem;
  font-weight: 600;
}
.btn--primary:hover { background: var(--gold-600); }
```
```js
const toggle = document.querySelector('[data-nav-toggle]');
toggle.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!open));
});
```

## Testing Strategy
Tidak ada unit test (halaman statis). Verifikasi manual:
- Buka di browser desktop (≥1280px), tablet (768px), mobile (375px) — tidak ada horizontal scroll.
- Semua link anchor navbar melompat ke section yang benar.
- Nav mobile & accordion FAQ berfungsi dengan mouse dan keyboard (Tab/Enter).
- Tidak ada error di console.
- Lighthouse (opsional): Accessibility ≥ 90, Performance ≥ 85.

## Boundaries
- **Always:** gunakan token warna dari palet di atas; teks alt pada semua gambar; `prefers-reduced-motion`; tanpa inline style; responsive mobile-first.
- **Ask first:** menambah library/CDN JS, mengubah palet, mengunduh aset foto ke repo, menambah halaman baru.
- **Never:** framework CSS/JS (Tailwind, Bootstrap, React), build tools, foto tanpa lisensi bebas, menaruh data pribadi sungguhan.

## Success Criteria
- [x] `index.html` memuat 9 bagian sesuai urutan di atas.
- [x] Palet dominan navy dengan aksen krem & kuning konsisten di semua section.
- [x] Hero menampilkan foto dari Unsplash yang relevan (mahasiswa/wisuda) dan heading terbaca jelas.
- [x] 3 value point, 1 quote, timeline 5 tahap, 4 langkah apply, info syarat + FAQ semuanya tampil.
- [x] Responsif 375px–1440px tanpa layout rusak.
- [x] Nav mobile & FAQ accordion berfungsi tanpa error console.
- [x] Hanya file HTML/CSS/JS vanilla, tanpa dependency.

## Open Questions
1. Nama pendiri/alumni untuk quote — pakai nama fiktif dulu?
2. Tanggal jadwal — pakai periode 2026/2027 fiktif?
3. Kontak (email/WA) di footer — pakai placeholder?
→ Jika tidak ada jawaban, saya lanjut dengan placeholder.
