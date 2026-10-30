# Phân loại tệp khách theo nguồn (Pancake)

Cho bạn biết **mỗi tệp khách đến từ đâu** — quảng cáo, comment bài viết, livestream hay khách tự nhắn —
kèm **điểm ưu tiên** để biết chốt ai trước.

```
tools/
├── lead_source.py        # công cụ chính (không cần thư viện ngoài)
├── make_sample_data.py   # sinh HAR mẫu để xem thử giao diện
├── serve_reports.py      # mở báo cáo HTML bằng web server nhỏ
└── rules.example.json    # cấu hình: map tag → nguồn, từ khoá ý định, trọng số điểm
reports/                  # báo cáo xuất ra (.html + .csv)
demo/                     # HAR mẫu + rules mẫu
```

## Chạy thử ngay với dữ liệu có sẵn

```bash
# 1. HAR hiện tại của repo (mới có 1 hội thoại, chưa có tin nhắn)
python3 tools/lead_source.py tinnhanmoi.har --out-dir reports

# 2. Dữ liệu mẫu 8 tệp khách đủ loại nguồn (để xem báo cáo trông thế nào)
python3 tools/lead_source.py demo/sample_messages.har \
        --rules demo/rules_demo.json --prefix demo \
        --banner "DỮ LIỆU MẪU — không phải khách thật" \
        --now 2026-10-30T04:10:00Z

# 3. Mở báo cáo
python3 tools/serve_reports.py                 # http://localhost:8000
```

Kết quả: `reports/<tên>_leads.html` (bảng tương tác, lọc theo nguồn) và `reports/<tên>_leads.csv` (mở Excel).

## Bắt HAR để có đủ dữ liệu (quan trọng)

HAR hiện tại (`tinnhanmoi.har`) chỉ bắt `POST /api/v1/conversations` → **chưa thấy** `post_id`, `referral`,
nội dung tin nhắn. Muốn phân loại chuẩn, bắt lại HAR như sau:

1. Chrome → `pancake.vn` → F12 → tab **Network**.
2. Tick **Preserve log** + **Include WebSocket messages** (nếu có).
3. Làm mới trang, rồi **mở 3 hội thoại**: một khách từ quảng cáo, một khách comment bài viết, một khách tự nhắn.
4. Chuột phải trong danh sách request → **Save all as HAR with content**.
5. Chạy: `python3 tools/lead_source.py <file>.har --explain`

`--explain` in ra **mọi field** có trong dữ liệu, dòng nào bắt đầu bằng `*` là field có khả năng liên quan đến
nguồn (`ad`, `referral`, `source`, `post`, `campaign`, `tag`, `type`…). Nếu thấy field nguồn mới, chỉ cần thêm
tên key đó vào `AD_KEYS` / `POST_KEYS` ở đầu `lead_source.py`.

## Nguồn được nhận diện thế nào

| Nguồn | Dấu hiệu (theo thứ tự ưu tiên) | Độ tin cậy |
|---|---|---|
| **Quảng cáo** | `extra_info.referral.ad_id`, `ads_context_data`, `ad_id`, `campaign_id`, `adset_id`, `click_id`… ở conversation hoặc ở từng message | cao |
| **Bài viết** | `post_id` / `post` khác null, hoặc `type` = `COMMENT` / `REPLY` | cao / trung bình |
| **Livestream** | `has_livestream_order` có giá trị, `live_video_id`, `type` chứa `LIVE` | trung bình |
| **Qua tag** | tag id có trong `rules.json → tag_map` và được gán `"source": "ads"/"post"/"live"` | trung bình |
| **Tự nhắn** | `type = INBOX` và không có dấu hiệu nào ở trên | thấp (mặc định) |
| **Chưa rõ** | `type` lạ, không khớp quy tắc nào | thấp |

Cột **Bằng chứng** trong báo cáo liệt kê đúng những dòng đã dùng để kết luận, ví dụ:

```
extra_info.referral.ad_id = 120210987654321
messages.[0].referral.source = ADS
tag #83 = Từ quảng cáo → nguồn Quảng cáo
```

→ Bạn kiểm tra được ngay máy phân loại đúng hay sai, không phải tin mù.

## Điểm ưu tiên (0–100)

| Tiêu chí | Điểm |
|---|---|
| Có tin chưa đọc | +30 |
| Tương tác cuối < 24h / < 3 ngày | +20 / +10 |
| Có số điện thoại | +15 |
| Ý định mua trong tin cuối (`giá`, `bao nhiêu`, `size`, `đặt`, `ship`, `chốt`…) | +20 |
| Từ quảng cáo / từ bài viết | +10 / +5 |
| ≥ 3 tin nhắn | +10 |

`≥ 70` → **CHỐT NGAY**, `40–69` → **Ưu tiên**, còn lại → **Theo dõi**.
Sửa toàn bộ trọng số trong `rules.json` mục `weights` / `thresholds`.

## Map tag → nguồn (tăng độ chính xác)

Pancake trả `tags: [4, 83, 172]` — chỉ là ID số. Tạo `rules.json`:

```json
{
  "tag_map": {
    "4":   { "name": "Khách mới",    "source": null },
    "83":  { "name": "Từ quảng cáo", "source": "ads" },
    "172": { "name": "Khách live",   "source": "live" }
  },
  "weights": { "unread": 30, "recent_24h": 20 },
  "thresholds": { "hot": 70, "warm": 40 }
}
```

Cách tìm tag id: mở Pancake → Hội thoại → bấm vào tag → xem URL, hoặc bắt HAR của
`GET /api/v1/tags` rồi đối chiếu `id` ↔ `name`.

## Tuỳ chọn dòng lệnh

| Cờ | Ý nghĩa |
|---|---|
| `--source ads` | chỉ xuất khách từ quảng cáo (`ads\|post\|live\|organic\|unknown`) |
| `--min-score 70` | chỉ xuất khách đáng chốt |
| `--json` | in JSON thay vì bảng (để nối vào hệ thống khác) |
| `--explain` | liệt kê mọi field trong dữ liệu, tìm field nguồn mới |
| `--rules file.json` | dùng cấu hình riêng |
| `--no-html` | chỉ xuất CSV |
| `--tz 7` | múi giờ hiển thị (mặc định VN) |

## Giới hạn — đọc trước khi tin

- Bộ quy tắc quảng cáo/bài viết viết theo cấu trúc Pancake quan sát được + field nguồn chuẩn của
  Facebook (`referral`, `ads_context_data`, `post_id`). **Chưa đối chiếu với HAR thật có đủ message**, nên
  hãy chạy `--explain` trên HAR mới để xác nhận tên field thực tế.
- **"Tự nhắn" là nhãn mặc định**, không phải bằng chứng: nếu Pancake không trả field nguồn nào và shop không
  dùng tag thì mọi khách đều rơi vào `organic`. Khi đó hãy dựa vào cột **Bằng chứng** + độ tin cậy.
- Không gọi API, không gửi dữ liệu đi đâu: chỉ đọc file HAR/JSON trên máy bạn.
- Token/cookie không được dùng ở đây. Nếu bạn muốn tự động lấy dữ liệu qua API thay vì bắt HAR, nói mình
  viết thêm script gọi `POST /api/v1/conversations` + `GET /api/v1/conversations/<id>/messages`.
