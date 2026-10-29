# Pemantau YouTube (versi GitHub)

Situs ini tetap bisa dibuka walau komputer Anda mati. GitHub mencatat angka YouTube
secara otomatis (kira-kira tiap 5 menit), lalu halaman membacanya.

## Memasang (sekali saja)
1. Buat repo baru di github.com (nama bebas, misalnya `pantau-youtube`), pilih Public.
2. Unggah semua isi folder ini ke repo (Add file > Upload files). Pastikan folder `.github` ikut terunggah.
3. Salin file `samples.jsonl` (dan `channel_samples.jsonl` kalau ada) dari folder `youtube-live\data` di komputer Anda
   ke folder `data` di repo, supaya riwayat lama tidak hilang.
4. Settings > Secrets and variables > Actions > New repository secret.
   Nama: `YOUTUBE_API_KEY`, isi: API key Anda.
5. Settings > Pages > Source: "Deploy from a branch", Branch: `main`, folder `/ (root)`, lalu Save.
6. Tab Actions > "Catat data YouTube" > Run workflow, untuk mencoba pencatatan pertama.
7. Alamat situs: https://NAMA-GITHUB-ANDA.github.io/NAMA-REPO/

## Menambah atau mengurangi video dan channel
Edit `config.json` langsung di github.com (ikon pensil). Video boleh berupa tautan atau ID.
Channel boleh berupa @handle atau tautan `/channel/UC...`.
Yang dihapus dari daftar berhenti dicatat, tetapi riwayat lamanya tetap ada di folder `data`.

## Catatan
- Pencatatan tiap 5 menit pun bisa tertunda puluhan menit saat GitHub sibuk. Celahnya ditandai di tabel.
- GitHub bisa menonaktifkan jadwal otomatis kalau repo tidak ada aktivitas 60 hari. Kalau pencatatan berhenti,
  buka tab Actions dan aktifkan lagi.
- Repo dan situs ini publik: siapa pun yang tahu alamatnya bisa melihat datanya. API key aman di Secrets.
