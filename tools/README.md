## Radar 2.7.0 — giữ lịch sử đo độc lập khỏi bảng

- Lịch sử tối đa 80 tin trong bộ nhớ phiên, không mất khi tin được gắn thẻ hoặc bấm 🧹. Reload khởi tạo lịch sử mới; không lưu nội dung khách vào localStorage.
- Đối chiếu DOM tiếp tục theo lịch sử thay vì danh sách hiển thị. 🔍 hiển thị 12 số đo gần nhất; `__radar.timings` trả bản tóm tắt toàn bộ lịch sử.
- `socketAt`: lúc bắt đầu xử lý văn bản socket (Date.now), chỉ gán khi tin thật sự đi từ handler socket; không lấy khung cũ để quy kết API là socket. `lampAt`: lúc mã đổi lớp đèn; `socketToLampMs`: chênh hai mốc. Không phải thời gian từ máy khách gửi, không phải thời điểm pixel hiển thị. Độ phân giải millisecond có thể trả 0.
- `domAt`: lần đầu quan sát thấy snippet khớp trong DOM. `leadMs`: DOM quan sát sau mã bật đèn bao nhiêu ms. `already-visible` chỉ cho biết nội dung đã hiện trong DOM lúc kiểm tra, không đo được trễ bao nhiêu. `unobserved` không có nghĩa báo trước; có thể do bộ lọc/virtualization/snippet rút gọn. Không đảm bảo đo browser paint.
- Sửa thông tin tin cuối/người gửi cuối khi publish tin Phoenix hợp lệ. Giữ nguyên bộ lọc chỉ khách chưa gắn thẻ và kích thước đèn 32 px.
- Kiểm thử: sau gắn thẻ vẫn giữ mốc socket/đèn, vẫn đối chiếu DOM, xoá bảng không xoá lịch sử, cập nhật sender Phoenix; mock và 19 ca DOM/API thật đạt.

## Radar 2.6.0 — đường Phoenix trực tiếp, đèn 32 px

- Nhận diện khung Phoenix JSON 5 phần tử ngay đầu đường nhận; truyền đối tượng đã parse xuống handler thay vì dò định dạng Facebook cũ rồi parse lại. Định dạng legacy vẫn giữ bộ dò cũ.
- WeakSet theo chính MessageEvent tránh xử lý hai lần do listener và onmessage cùng nhận một sự kiện. Không gộp hai MessageEvent khác nhau, không chặn listener ứng dụng.
- Sau khi bật tín hiệu đèn, dựng bảng/nhật ký được gộp bằng một setTimeout 0; giảm việc dựng bảng trong callback socket. Đây không phải cam kết browser paint trước React; server/network vẫn là giới hạn.
- Đèn tăng 24 → 32 px, viền 3 px và quầng sáng rõ hơn. Giữ kéo thả, nhớ vị trí, nháy xanh cho tin đã xác nhận chưa gắn thẻ. Không tăng nhịp API.
- Kiểm thử fake socket nay gửi cùng MessageEvent qua cả listener/onmessage giống trình duyệt; kiểm tra đúng một lượt xử lý, bộ đếm đường trực tiếp, kích thước đèn và các ca hồi quy. Mock và 19 ca DOM/API thật đạt.

## Radar 2.5.1 — đèn nhỏ 24 px

Thu đèn 46 → 24 px, viền 2 px, ẩn số đếm trên đèn cho gọn. Giữ kéo thả, lưu vị trí và nháy xanh. Giới hạn viewport theo kích thước mới. Không thay đổi đường nhận tin; chưa có bằng chứng cải thiện độ trễ từ server/DOM.

## Radar 2.5.0 — đèn kéo thả khi thu bảng

- Nút ✕ thu bảng, không tắt radar. Đèn đỏ là trạng thái chờ, **không phải báo lỗi kết nối**. Bấm đèn để mở lại bảng.
- Tin khách chưa gắn thẻ đã xác nhận (hoặc tin thử 🧪) làm đèn nháy xanh 2,5 giây. Tin trùng/đã có thẻ/shop không tạo tín hiệu. Xanh không có nghĩa dự đoán trước lúc server gửi hoặc đảm bảo DOM chưa xuất hiện.
- Ưu tiên đổi lớp đèn trước khi dò vị trí DOM/dựng nội dung bảng. Khi thu bảng, không dựng lại danh sách và chẩn đoán nặng. Màn hình chỉ thực sự đổi màu khi trình duyệt paint, không thể đảm bảo sớm hơn React cùng frame.
- Kéo đèn bằng pointer (chuột/cảm ứng), lưu `lampPos` trong `radar.cfg` ở localStorage. Giới hạn đèn trong viewport, áp lại vị trí khi reload/resize. Kéo không kích hoạt click mở bảng.
- Kiểm thử: đóng/mở bảng, nhận tin lúc đóng, lớp tín hiệu, đặt/lưu vị trí, kéo thả và chặn click sau kéo; bộ mô phỏng và 19 ca DOM/API thật đạt. Chưa đo thời điểm paint trên trình duyệt người dùng.

## Radar 2.4.0 — bỏ xác minh dư sau socket đầy đủ

Dựa trên log v2.2.0 của người dùng: 272 khung update, cả 272 có người gửi và nội dung; 134 lần gọi riêng trang, 496 lượt xử lý danh sách. Không còn coi mọi khung là bản vá mỏng.

Khung có id, snippet, sender id, updated_at và tags được xử lý trực tiếp như trước nhưng **không gọi lại API trang sau đó**. Khung thiếu dữ liệu vẫn xác minh; khung chắc chắn có thẻ không gọi xác minh khi chỉ theo dõi chưa gắn thẻ. Không tăng polling, không chặn listener ứng dụng, không thay đổi luật chỉ tin tới/chưa gắn thẻ. 🔍 bổ sung ba bộ đếm đường trực tiếp/bỏ khung có thẻ/cần xác minh.

Đây là giảm request dư và tải xử lý, không đảm bảo thắng thời điểm React hiển thị. Log cũ chỉ có pending/unobserved nên chưa đo được lợi thế DOM. Kiểm thử bổ sung xác nhận khung đầy đủ không phát request trang.

## Radar 2.3.0 — chỉ hiển thị tin khách chưa gắn thẻ

Mặc định `onlyUntagged: true`. Bộ lọc chạy trước khi đưa tin vào bảng/phát thông báo trên mọi nguồn: chỉ nhận khi hội thoại có `tags` là mảng rỗng. Có thẻ (kể cả mã âm) hoặc chưa biết thẻ đều không báo. Không dựa vào tên nguồn NO_TAG. Tin thử 🧪 vẫn được phép để thử giao diện.

Khi API/socket cập nhật hội thoại thành đã có thẻ, loại tin của hội thoại đó khỏi bảng. Vẫn tiếp tục thu thập dữ liệu để biết chiều tin và trạng thái thẻ, không ngắt socket. 🔍 có bộ đếm bỏ tin có thẻ/chưa rõ thẻ.

Kiểm thử bổ sung: mặc định bật lọc; socket có thẻ; thiếu trường tags; mảng rỗng; gắn thẻ sau khi đã báo. Các ca hồi quy đường nhận tin cũ chạy ở chế độ mọi thẻ để không mất kiểm tra các bộ phân tích cũ.

## Radar 2.2.0 — đường socket nhanh và đo từng tin

- `pages:update_conversation` gọi xác minh riêng trang ngay, bỏ debounce 80 ms chung vốn có thể để khung trang B huỷ việc xác minh trang A.
- Giữ giới hạn 1,5 giây/trang. Nếu tín hiệu rơi trong giới hạn, đặt một lần gọi cuối nhịp cho **từng trang**, không bỏ hẳn tín hiệu. Không tăng nhịp polling nền.
- Khung đủ nội dung/người gửi vẫn đi qua luật kiểm tra chiều tin; khung chỉ đổi tag không được tự thông báo là khách nhắn.
- Giữ mã hội thoại/trang thật khi báo, phục vụ đối chiếu đúng dòng trên multi-pages.
- Bỏ khẳng định “websocket = báo trước”. Mỗi tin ghi trạng thái: nội dung đã có trong DOM khi báo / chờ đối chiếu / quan sát thấy DOM sau thông báo N ms / không quan sát thấy sau 30 giây.
- 🔍 ghi `socketToAlertMs` (khung cập nhật gần nhất của hội thoại → báo) và `leadMs` (báo → lần đầu quan sát thấy nội dung khớp trong DOM). Đây là số đo DOM, **không phải thời điểm browser paint**, không phải độ trễ từ lúc khách bấm gửi. Khung cập nhật gần nhất có thể là thay đổi tag, không nhất thiết là sự kiện tạo tin.
- Đối chiếu chỉ trên dòng có trong DOM, không suy luận tin bị lọc/ngoài màn hình là “báo trước”. So khớp snippet sau chuẩn hoá; nếu giao diện rút gọn nội dung khác API thì không kết luận.
- Kiểm thử: mock 78 mục, DOM/API thật 19 mục. Cần lấy 🔍 trên trình duyệt người dùng để xác nhận lợi thế thực tế.

## Radar 2.1.0 — sửa đọc giờ và đính chính bộ lọc

**Đính chính thông tin 2.0.0 bên dưới:** không thể khẳng định `tags=["NO_TAG"]` chỉ trả hội thoại chưa gắn tag. Trong `tinnhanmoi.har`, chính response của request này có hội thoại mang `tags: [4,83,172]`. Bản 2.1.0 thử request không lọc tag; nếu HTTP lỗi thì thử biến thể trong HAR. Đây là đường cần kiểm chứng trên trình duyệt thật, không phải bằng chứng đã hoạt động ngoài thực tế.

Lỗi cụ thể tìm thấy trong mã: `Date.parse(updated_at)` hiểu chuỗi thiếu múi giờ theo giờ máy. Pancake trả `2026-10-30T04:07:08.173000`, còn header response là `Fri, 30 Oct 2026 04:07:08 GMT`. Ở Việt Nam, đọc sai thành giờ địa phương khiến tin mới bị lệch 7 tiếng và bị loại là tin cũ. 2.1.0 đọc chuỗi này theo UTC, dùng chung cho socket và danh sách.

- Nhãn chưa gắn tag chỉ xuất hiện khi trường `tags` là mảng rỗng; thiếu trường không được đoán là chưa có tag.
- Lần đầu nhận nguồn bổ sung chỉ ghi mốc, tránh báo hàng loạt tin cũ.
- Sau 12 giây có dòng tự kiểm tra trên bảng; trạng thái HTTP cũng được ghi lại. Dấu kiểm chỉ thể hiện kiểm tra kỹ thuật, **không chứng minh báo trước hoặc không bỏ sót**.
- Kiểm thử ở múi giờ `Asia/Ho_Chi_Minh`: mock 75 mục; DOM + API thật 19 mục. Các bộ kiểm thử nhãn hiện có đạt.
- Chưa xác nhận thời điểm báo so với dòng hiển thị trong phiên Pancake của người dùng; không cam kết báo trước từ kết quả mô phỏng.

# Phân loại tệp khách theo nguồn (Pancake)

Cho bạn biết **mỗi tệp khách đến từ đâu** — quảng cáo, comment bài viết, livestream hay khách tự nhắn —
kèm **căn cứ** để bạn tự kiểm tra máy phân loại đúng hay sai (không chấm điểm).

```
userscripts/
└── pancake-lead-badges.user.js   # Tampermonkey: gắn nhãn + bảng nổi ngay trên Pancake
tools/
├── lead_source.py        # công cụ chính (không cần thư viện ngoài)
├── make_sample_data.py   # sinh HAR mẫu để xem thử giao diện
├── serve_reports.py      # mở báo cáo HTML bằng web server nhỏ
├── test_userscript.js    # (JS) so classifier userscript với bản Python
├── test_userscript_dom.js# (JS + jsdom) test nhãn / Alt+O / chỉ dòng hiển thị
├── test_userscript_real.js# (JS) test classifier trên dữ liệu THẬT
├── test_userscript_selectors.js # (JS + jsdom) test khi Pancake đổi tên class
├── build_real_fixture.py # rút dữ liệu thật từ HAR -> demo/real_leads.json
└── rules.example.json    # cấu hình: map tag → nguồn, từ khoá ý định, trọng số điểm
reports/                  # báo cáo xuất ra (.html + .csv)
demo/                     # HAR mẫu + rules mẫu
```

## ⚡ Userscript Tampermonkey (khuyến nghị)

Cài: Tampermonkey → *Create a new script* → dán `userscripts/pancake-lead-badges.user.js` → Ctrl+S → mở
`pancake.vn` trang **Hội thoại**.

**Chỉ gắn nhãn cho các dòng ĐANG HIỂN THỊ trên màn hình** (Pancake dùng danh sách ảo hoá nên mỗi lượt chỉ
có vài chục dòng trong DOM). Cuộn tới đâu, nhãn xuất hiện tới đó — nhờ vậy không lag dù có hàng nghìn hội thoại.

```
🔥 QC 90   Ngọc Ánh     Còn size M không shop…
🔥 TN 70…  Trần Bảo     Mẫu trong video còn màu đen…   (đang xem tin nhắn)
🔥 BV 85   Hồng Nhung   Ib mình mẫu này với ạ
```

- `…` = **chưa xem tin nhắn xong** (chưa chắc nguồn) — script tự xem tin nhắn của **các dòng đang hiển thị**
  rồi tự đổi nhãn (`TN 70…` → `QC 80`), không cần bạn mở chat.
- Rê chuột vào nhãn: nguồn · điểm · độ tin cậy · **bằng chứng**.

### Bật / tắt

| Điều khiển | Tác dụng |
|---|---|
| **Alt + O** | ẩn/hiện **tất cả** (bảng + nhãn). Nút 🏷️ vẫn còn để bật lại |
| **✕** trên bảng | như Alt+O |
| **▭** trên bảng | **chỉ ẩn bảng — nhãn trên dòng chat vẫn chạy** (phân loại vẫn hoạt động khi giao diện tắt) |
| Nút nổi **🏷️ / ▤** góc phải | mở lại bảng/tất cả |
| `__leadSource.hide() / .show() / .toggle()` | điều khiển bằng console |

Dữ liệu, enrich và phân loại **luôn chạy kể cả khi đã ẩn giao diện** → bật lại là có nhãn ngay, không phải chờ.

### Vì sao nhanh (không lag)

| Trước (v2) | Nay (v3) |
|---|---|
| Quét toàn bộ `span,div,a,p,b,strong,h4` của trang mỗi 400 ms | chỉ đọc `.conversation-list-item` và lọc theo khung nhìn (`getBoundingClientRect`) |
| Đoán dòng bằng cách so khớp **tên khách** | khớp chính xác bằng `id` thật: `<page_id>_<psid>__<n>` |
| MutationObserver trên `document.documentElement` + `characterData` | chỉ trên `.conversation-list` |
| Vẽ lại bảng mỗi 200 ms | vẽ lại khi dữ liệu đổi (so signature), tối đa 0,7 s/lần |
| Enrich mọi hội thoại | enrich **chỉ dòng đang hiển thị**, 4 hội thoại/lượt, cache 10 phút |

### Cấu hình (console, lưu vào localStorage)

```js
__leadSource.set({ tagMap: { "83": { name: "Từ quảng cáo", source: "ads" } } })   // tag id từ API
__leadSource.set({ tagNameSource: { "QC": "ads", "LIVE": "live" } })             // tên tag trên dòng chat
__leadSource.set({ enrichVisible: false })        // tắt xem tin nhắn ngầm
__leadSource.set({ enrichLimit: 8, pollMs: 30000, scanMs: 2000 })
__leadSource.set({ enabled: false })              // như Alt+O
__leadSource.visibleRows                          // id các hội thoại đang hiển thị
__leadSource.help()
```

### 🚑 Không thấy nhãn / danh sách không cập nhật?

Pancake đổi giao diện là chuyện bình thường — bản 3.2 tự dò lại DOM (3 lớp: selector chuẩn →
con của `.conversation-list` → quét mọi phần tử có `id` dạng `<page>_<psid>`), và đọc dữ liệu theo
**dấu hiệu dữ liệu** (`json.conversations`, `messages[].conversation_id`) chứ không phụ thuộc URL.

Kiểm tra theo thứ tự:

```js
__leadSource.debug()      // in + copy báo cáo chẩn đoán (gửi mình là biết sửa gì)
```

| Trong báo cáo | Nghĩa | Cách xử lý |
|---|---|---|
| `enabled: false` | bạn đã **tắt hẳn** bằng Alt+O/✕ ở lần trước (script không chạy gì cả) | bấm nút 🏷️ góc phải hoặc `__leadSource.show()` |
| `running: false` | đang tắt: không vòng quét, không poll, không gọi mạng | bật lại khi cần |
| `decorateMs` | thời gian gắn nhãn 1 lượt (bình thường 1–5 ms) | nếu > 30 ms, gửi mình `debug()` |
| `convs: 0` | chưa bắt được danh sách hội thoại | F5 lại trang Hội thoại; nếu vẫn 0, gửi mình `debug()` |
| `domMode: "none"`, `rowsFound: 0` | DOM đổi cấu trúc, không tìm ra dòng | gửi mình `sampleRowHtml` trong báo cáo |
| `rowsFound > 0`, `rowsWithChip: 0` | tìm ra dòng nhưng không gắn được nhãn | xem `verdict` + `sampleRowHtml` bên dưới |
| `verdict: "thấy dòng nhưng KHÔNG đọc được id hội thoại"` | id nằm ở chỗ khác (thẻ bọc / thuộc tính khác) | bản 3.2 đã tự leo thẻ bọc; nếu vẫn lỗi, gửi `sampleRowHtml` |
| `idFromWrapper: true` | id hội thoại nằm ở **thẻ bọc** `div[offsetx]`, dòng con không có id | bình thường ở màn hình mới, bản 3.2 xử lý được |
| `rowsNoName > 0` | có dòng không tìm thấy tên khách → nhãn gắn vào dòng chót (đầu dòng) | gửi `sampleRowHtml` để mình thêm selector |
| `domMode: "id-scan"` | đang chạy chế độ dự phòng (vẫn đúng) | không cần làm gì |
| `verdict: "OK"` | mọi thứ đúng | không cần làm gì |
| Tắt giao diện rồi bật lại mà **không có nhãn** | bản ≤3.2.0 chỉ *hẹn giờ* gắn nhãn khi bật lại; timer bị nuốt (hoặc tab vừa ẩn) là mất nhãn | đã sửa ở 3.2.1: bật lại là gắn **ngay**, kèm watchdog tự phục hồi + gắn lại khi quay về tab |

Pancake dùng **2 kiểu đánh dấu dòng** (bản 3.2 nhận cả hai):

```html
<!-- A. id ngay trên dòng -->
<div id="675541385634278_28794751720156211__0" class="media conversation-list-item">…

<!-- B. id ở thẻ bọc, dòng con KHÔNG có id  (màn hình dùng virtual list) -->
<div offsetx="0" id="675541385634278_28794751720156211">
  <div class="media conversation-list-item">…
```

Kiểu B chính là nguyên nhân lỗi "0 nhãn" của bản 3.1: dòng vẫn tìm ra nhưng `id` rỗng nên
không biết đang gắn cho hội thoại nào. Bản 3.2 leo lên tối đa 7 cấp thẻ bọc để lấy id.

Có thể chỉ định selector trực tiếp nếu biết:

```js
__leadSource.set({ selRow: '.ten-class-dong-moi', selName: '.ten-class-ten-khach' })
```

## 🧪 Dữ liệu thật nói gì (đọc từ `loaddanhsach.har` + `batmesss.har`)

| Phát hiện | Ý nghĩa |
|---|---|
| `extra_info` **luôn rỗng**, `post_id`/`post` **luôn null** (947 hội thoại) | ❌ không thể biết nguồn chỉ từ danh sách hội thoại |
| `type` = `INBOX` (946) / `COMMENT` (2) | ✅ comment nhận ra ngay từ danh sách |
| Tin nhắn có `attachments[].type = "ad_click"` + `attachments[].ad_id` | ✅ **đây là dấu hiệu quảng cáo thật** — nhưng phải xem tin nhắn |
| `has_livestream_order` luôn null; `is_livestream_order` có trong message | livestream lấy từ message |
| Điểm danh sách: `GET /api/v1/pages/<page>/conversations`; tin nhắn: `GET /api/v1/pages/<page>/conversations/<id>/messages` | đúng URL script dùng để enrich |

Kết quả trên 9 hội thoại thật (đã ẩn danh, `demo/real_leads.json`): **9/9 đúng** — 5 quảng cáo, 2 bài viết, 2 tự nhắn.

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

## Không chấm điểm — chỉ gắn loại tin khi có bằng chứng

Bản 3.3.0 bỏ hẳn cơ chế điểm (trước đây cộng điểm chưa đọc / mới tương tác / có SĐT / ý định mua…).
Lý do: điểm không nói được **tin này từ đâu tới**, mà đó mới là thứ cần để chốt.

| Loại | Khi nào gắn | Căn cứ (hiện trong tooltip) |
|---|---|---|
| **QC** Quảng cáo | có tin nhắn với `attachments[].type = "ad_click"` (kèm `ad_id`) | `tin nhắn 1.attachments[0].type = ad_click · ad_id 1202…` |
| **BV** Bài viết | attachment có `comment` / `post_attachments`, hoặc hội thoại `type = "COMMENT"` | `hội thoại type = COMMENT (bình luận bài viết)` |
| **LV** Livestream | chỉ khi có cờ thật: `is_livestream_order` / `has_livestream_order` / `live_video_id` | `tin nhắn 1 có cờ livestream` |
| **TN** Tự nhắn | **đã đọc tin nhắn** và không có dấu hiệu nào ở trên | `đã đọc 15 tin nhắn: không có ad_click / bài viết / livestream` |
| **?** Chưa kiểm tra | **chưa đọc được tin nhắn** → không đoán | `chưa đọc tin nhắn của hội thoại này → chưa kết luận` |

Đây là lý do bản cũ hiện **TN rồi bấm vào lại thành QC**: chưa đọc tin nhắn thì nó mặc định
"tự nhắn"; đọc xong mới thấy `ad_click`. Giờ chưa đọc thì hiện `?`, đọc xong mới kết luận.

Muốn chắc chắn có bằng chứng: mở tooltip trên nhãn, hoặc xem cột **Căn cứ** trong báo cáo HTML.

## Map tag → nguồn (tăng độ chính xác)

Pancake trả `tags: [4, 83, 172]` — chỉ là ID số. Tạo `rules.json`:

```json
{
  "tag_map": {
    "4":   { "name": "Khách mới",    "source": null },
    "83":  { "name": "Từ quảng cáo", "source": "ads" },
    "172": { "name": "Khách live",   "source": "live" }
  },
}
```

Cách tìm tag id: mở Pancake → Hội thoại → bấm vào tag → xem URL, hoặc bắt HAR của
`GET /api/v1/tags` rồi đối chiếu `id` ↔ `name`.

## Tuỳ chọn dòng lệnh

| Cờ | Ý nghĩa |
|---|---|
| `--source ads` | chỉ xuất khách từ quảng cáo (`ads\|post\|live\|organic\|unknown`) |
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

### ⚡ Tắt là tắt hẳn + không làm chậm Pancake (3.4.0)

| Nút | Việc xảy ra |
|---|---|
| **✕ / Alt+O** | tắt **toàn bộ**: dừng mọi timer, ngắt MutationObserver, huỷ enrich đang chờ, **không gọi mạng**, không xử lý dữ liệu mới. Nút 🏷️ vẫn còn để bật lại. |
| **▭** | chỉ ẩn bảng, nhãn trên dòng chat vẫn chạy |

Tối ưu tốc độ:
- cache kết quả phân loại (Pancake render lại liên tục cũng không phải tính lại)
- nhãn chỉ được ghi lại khi loại tin thật sự đổi
- cache danh sách dòng, xoá khi Pancake render lại
- nhịp quét dự phòng 3s (trước 1.5s), mỗi lượt enrich 3 hội thoại cách nhau 0.7s
- đo thực tế trên DOM thật (31 dòng): **~2–3 ms/lượt gắn nhãn**

### 🏷️ Nút bật/tắt nhãn (3.5.0)

Trên bảng có nút **`🏷️ Nhãn BẬT` / `🚫 Nhãn TẮT`**:

| Bấm | Kết quả |
|---|---|
| `🏷️ Nhãn BẬT` | hiện nhãn QC/BV/LV/TN/? trên từng dòng hội thoại |
| `🚫 Nhãn TẮT` | **chỉ ẩn nhãn**, bảng và script vẫn chạy, bấm lại là hiện ngay |
| `🔁 N` | đọc lại tin nhắn cho các dòng đang hiển thị (khi thấy nhiều `?`) |
| `✕` / `Alt+O` | đóng bảng **và** nhãn, dừng mọi vòng quét/gọi mạng; script chỉ đọc thụ động dữ liệu Pancake tự tải |

### Vì sao trước đây toàn ra "?" (đã sửa ở 3.5.0)

Pancake trả **hồ sơ khách, không có `messages`** với hai kiểu URL:

| URL | Trả về |
|---|---|
| `…/messages?customer_id=…` | ❌ hồ sơ khách |
| `…/messages?` (rỗng) | ❌ hồ sơ khách |
| `…/messages?customer_id=…&separate_pos=true` | ✅ có tin nhắn |
| `…/messages?customer_id=…&user_view=true&is_new_api=true&separate_pos=true` | ✅ có tin nhắn |

Bản cũ chỉ gọi **một** URL; nếu rơi vào ca ❌ thì không bao giờ có tin nhắn → dòng nào cũng `?`.
Bản 3.5.0 thử **lần lượt** các biến thể trên và dùng biến thể trả về `messages`.
Nếu vẫn `?`, xem `__leadSource.debug().enrichLast.keys` — nó cho biết Pancake trả khóa gì.

### 🏷️ Nhãn và bảng là hai thứ riêng (3.6.0)

| Thao tác | Bảng | Nhãn trên dòng chat |
|---|---|---|
| `▭` / `✕` / `Alt+O` | đóng | **vẫn hiện, vẫn cập nhật** |
| Bấm nút nổi `▤` | mở lại | vẫn hiện |
| `🏷️ Nhãn BẬT/TẮT` | không đổi | **nút duy nhất tắt/bật nhãn** |
| `__leadSource.set({enabled:false})` | đóng | tắt, dừng hẳn script |

Nói ngắn: đóng bảng không bao giờ làm mất nhãn. Chỉ nút 🏷️ Nhãn mới tắt nhãn.

### 🎯 Vì sao "TN rồi kéo tin lên lại thành QC" — và cách sửa đúng (3.7.0)

`ad_click` nằm ở **tin đầu tiên** của hội thoại (khách bấm quảng cáo rồi mới nhắn), còn
script chỉ tải **trang tin mới nhất**. Vì vậy bản cũ không thấy `ad_click` → gắn TN; khi bạn
kéo lên, Pancake tải tin cũ → thấy `ad_click` → đổi thành QC.

Dữ liệu thật cho thấy Pancake còn trả **nguồn ở cấp hội thoại** ngay trong response tin nhắn:

```json
{ "messages": [...],
  "ad_clicks": { "<customer_uuid>": [{ "ad_id": "1202…", "post_id": "…", "inserted_at": "…" }] },
  "activities": [{ "ad_id": "1202…" }],
  "post": null }
```

- 27/31 response tin nhắn có `ad_clicks`
- có response chỉ 2 tin, **không có `ad_click`** trong tin nào nhưng `ad_clicks` vẫn có
- danh sách hội thoại thì **không** có field này (0/1177)

Từ 3.7.0, script đọc `ad_clicks` / `activities[].ad_id` / `customers[].ad_clicks` / `post` /
cờ livestream **ngay khi tải tin nhắn**, nên QC/BV quyết ngay lần đầu — không phụ thuộc
trang tin mới nhất, không cần cuộn lên.

### ⚡ Giảm tải trang (3.7.0)

| Việc | Trước | Sau |
|---|---|---|
| Dò response lạ trong lúc tải trang | 30 giây | **8 giây** |
| Parse response không liên quan (avatar, logs, pos-api, contents…) | có | **bỏ** |
| Gọi lại danh sách | 2 request / 25 giây | **1 request / 45 giây** |
| Bộ nhớ đệm nguồn | — | giới hạn 600 hội thoại |

Đo trên fixture DOM thật 31 dòng: nhãn đầu tiên sau **~0,55 giây**, mỗi lượt gắn nhãn **3–5 ms**.

### 📡 Biết trước khi dòng hiện ra — websocket (3.8.0)

Câu hỏi: *"có gì chứng minh tin nhắn tới TRƯỚC khi hội thoại hiện trên danh sách không?"*
Có. Trong `batmesss.har` có **1 kết nối websocket thật** tới `wss://edge-chat.facebook.com/chat`
(118 khung). Khung `deleteThenInsertThread` mang sẵn:

```
entity_id=61594409994701                 <- psid khách
"name","ad_id.120251435064020732"        <- nhãn quảng cáo Facebook gắn cho hội thoại
"đắt cái áo mà 10 ngày chưa có"          <- nội dung tin mới
```

Đo trên chính HAR đó: **7/9** hội thoại có dữ liệu tin nhắn tới **trước** lần xuất hiện đầu tiên
trong danh sách (sớm hơn 0,3 giây … 114 giây). Nói cách khác: Pancake/Facebook đã biết khách đến
từ quảng cáo nào **trước** khi dòng chat kịp vẽ ra.

Từ 3.8.0 script nghe chính khung đó:

| Việc | Cách làm |
|---|---|
| Nhận tin trước | hook `WebSocket` (giữ nguyên hành vi của trang), đọc khung có `ad_id.` |
| Ghép với hội thoại | `entity_id=<psid>` + page id trên URL → `<page_id>_<psid>` |
| Chống đoán bừa | khung có **nhiều hơn 1 psid** (khung gộp) → bỏ; không có `ad_id` → bỏ |
| Tắt khi cần | `__leadSource.set({wsRealtime:false})` |

Kết quả: nhãn **QC** có thể hiện ngay khi dòng vừa xuất hiện, không phải chờ gọi API tin nhắn.
Đọc thêm tin nhắn vẫn giữ nguyên (để nhận BV/LV và xác nhận lại).
Nếu websocket không có (mạng chặn, FB đổi định dạng) thì mọi thứ tự quay về như 3.7.0, không lỗi.

## 📨 Radar tin nhắn TỚI — script riêng (`userscripts/pancake-new-message-radar.user.js`)

Báo **tin khách gửi đến**: tên khách · nội dung · vị trí dòng. Bản **2.0.0** (báo được cả hội thoại CHƯA GẮN TAG + nhanh hơn).

### 2.0.0 — vì sao trước đây chỉ báo tin ĐÃ GẮN TAG

Danh sách mặc định của ứng dụng bị **lọc theo tag** (xem `loaddanhsach.har`:
`GET /api/v1/pages/694078980461601/conversations?…&tags=[4,5,10,13]&except_tags=[]`).
Hội thoại **chưa gắn tag** — tức khách mới nhắn lần đầu — không nằm trong lát cắt đó, nên radar
chỉ thấy những hội thoại đã được gắn tag. Đúng hiện tượng “chỉ báo tin đã gắn tag”.

Bản 2.0.0 hỏi thêm một request **riêng cho nhóm chưa gắn tag**, chép đúng từ `tinnhanmoi.har` (entry #5):

```
POST /api/v1/conversations?pages[..]=0&unread_first=true&mode=OR
     &tags=["NO_TAG"]&except_tags=[]&cursor_mode=true&from_platform=web
body: multipart/form-data  type=ALL,UNREAD
```

| Thay đổi | Số liệu |
|---|---|
| hỏi riêng nhóm chưa gắn tag | mặc định mỗi **1,2 giây** (`untaggedMs`), chặn 700 ms, tự tắt sau 3 lần lỗi |
| tin từ nhóm này hiện nhãn **🏷️ chưa gắn tag** | để phân biệt với tin từ danh sách có tag |
| dòng vừa đổi → gọi lại danh sách | 150 ms → **60 ms** |
| khung socket báo hội thoại đổi → gọi riêng trang | 150 ms → **80 ms** |
| gọi lại “khẩn” không bị chặn nhịp | 250 ms → **150 ms** |

Chẩn đoán có thêm dòng:

```
chưa gắn tag: hỏi N lần · lỗi K · M hội thoại chưa gắn tag đã thấy
```

Muốn nhanh hơn nữa (đổi lại bất cứ lúc nào trong console):

```js
__radar.set({ untaggedMs: 800 })   // hỏi nhóm chưa gắn tag mỗi 0,8 giây
__radar.set({ pollMs: 1500 })      // danh sách thường
__radar.set({ untaggedPoll: false })  // tắt hẳn nếu thấy nặng
```

### 1.9.0 — báo TRƯỚC khi dòng hiện: dùng đúng khung socket của Pancake

Sau 1.8.0, bảng 🔍 trên `/multi_pages` đã cho thấy socket thật:

```
khung nhận: 403 · khung JSON: 403
socket topics: users:… · multiple_pages:… (400)
socket events: phx_reply (2) · online_status · pages:tag_conversations (56)
               pages:update_conversation (332) · pages:seen_conversation (10)
khung thô:
  ["7",null,"multiple_pages:<uid>","pages:update_conversation",
   {"page_id":"769625892902516","conversation":{"id":"769625892902516_2890…","type":"INBOX","tags":[…],"seen":true,…}}]
```

Nghĩa là kênh thời gian thực có thật, tên sự kiện là **`pages:update_conversation`**, và nó tới
**trước** khi React vẽ lại dòng — đúng thứ cần cho “báo trước”. 1.8.0 chỉ dò đệ quy nên không dùng được khung này.

1.9.0 xử lý riêng khung đó:

| Trường hợp | Hành vi |
|---|---|
| khung có `conversation.snippet` + `conversation.last_sent_by` | **báo ngay** tại thời điểm khung tới, ghi `báo TRƯỚC khi dòng hiện` |
| khung chỉ là bản vá (thiếu `last_sent_by`, ví dụ chỉ `tags`/`seen`) | **không đoán** chiều tin; gọi riêng trang đó sau **150 ms** để lấy bản chuẩn rồi báo |
| khung của trang khác (multi-pages) | dùng `payload.page_id` để gọi đúng trang, chặn 1,5 giây/trang |

Chẩn đoán thêm 4 dòng để lần sau khỏi phải suy đoán:

```
khung cập nhật hội thoại: N · có người gửi: M · có nội dung: K
khoá trong khung gần nhất: id,type,tags,success,seen,…
nhịp quét đã chạy: N lần
gọi lại: thành công … · HTTP lỗi … · JSON lỗi … · bỏ vì quá sát nhịp … · tab ẩn …
```

Nếu `có người gửi: 0` mà `có nội dung: 0` → khung socket không mang nội dung tin, khi đó đường nhanh nhất
vẫn là: khung tới → gọi riêng trang (150 ms) → API trả `last_sent_by` → báo; thường vẫn trước khi dòng đổi màu.

### Vì sao 1.7.0 vẫn không báo — đọc từ bảng chẩn đoán THẬT của người dùng

Bảng 🔍 trên `/multi_pages` ghi:

```
socket đã thấy:
  wss://pancake.vn/socket/websocket?vsn=2.0.0
khung nhận: 0 · cấp tin nhắn: 0 · cấp hội thoại: 0
request danh sách: 1 lần · tự gọi lại: 2 lần
nguồn request: XMLHttpRequest GET — https://pancake.vn/api/v1/conversations?pages[…]
```

Ba lỗi lộ ra ngay từ đó:

| Dấu hiệu | Nguyên nhân trong mã 1.7.0 |
|---|---|
| thấy socket nhưng **0 khung** | hook chỉ gắn listener khi url khớp `/facebook\.com\|\/chat\|lightspeed\|messenger/i`; socket của Pancake (`wss://pancake.vn/socket/websocket?vsn=2.0.0`, Phoenix) **không khớp** → không nghe gì |
| `tự gọi lại: 2 lần` trong ~29 giây | `pollMs` 2000 nhưng chặn trùng cũng 2000 → mỗi lần sau bị chính lần trước chặn, nhịp rơi còn ~1/2 (và tệ hơn khi lệch giờ) |
| `body học được: chưa` | trên `/multi_pages` ứng dụng dùng **GET** (không body) — bình thường, không phải lỗi |

Và dữ liệu danh sách vẫn về bình thường (`danh sách: 145 hội thoại`, `bỏ 1 tin shop`) — nghĩa là phần đọc API đã đúng, chỉ thiếu **nguồn thời gian thực** và nhịp quét.

### 1.8.0 sửa gì

1. **Nghe MỌI socket** (trừ analytics): gắn cả `addEventListener('message')` lẫn `onmessage`, nên socket Pancake được đọc.
2. **Hiểu khung Phoenix** `[join_ref, ref, topic, event, payload]`:
   - ghi lại **tên topic + event** vào chẩn đoán (không đoán tên event);
   - `payload` được dò đệ quy: gặp đối tượng giống **hội thoại** (`from_psid` + `snippet`/`updated_at`) thì đưa vào đúng đường xử lý danh sách (biết chiều nhờ `last_sent_by`); gặp đối tượng giống **tin nhắn** (`{ from:{id}, original_message, conversation_id, inserted_at }` — đúng dạng thật trong `loaddanhsach.har`) thì báo ngay.
3. **Không báo lịch sử**: tin có `inserted_at` cũ hơn 5 phút bị bỏ (khi mở hội thoại, server đẩy cả loạt tin cũ).
4. **Nhịp quét đúng**: khoảng chặn = `pollMs − 200 ms`, thêm `cache: 'no-store'` để không dùng bản cache.
5. **Đếm được mọi thứ**: `gọi lại: thành công · HTTP lỗi · JSON lỗi · bỏ vì quá sát nhịp · tab ẩn`.
6. **Nhịp tim 30 giây** trong nhật ký: `💓 30 giây: quét N lần · danh sách M lần · khung K · bỏ X tin shop`.
7. **🔍 hiện thêm**: `socket topics`, `socket events`, `khung thô gần nhất` (3 khung cuối, cắt 240 ký tự) — đủ để đối chiếu nếu còn sai.

### Vì sao 1.6.0 vẫn “không hoạt động” — bằng chứng trong repo

Đây là lỗi nặng nhất và đã tìm ra bằng dữ liệu, không đoán:

| Bằng chứng | Nơi đọc được | Nghĩa là |
|---|---|---|
| `POST /api/v1/conversations` có `_resourceType: "xhr"` | `tinnhanmoi.har` (entry #5) | ứng dụng gọi bằng **XMLHttpRequest**, không phải `fetch()` |
| trang nạp chunk `vendor-axios-*.js` | `html.txt`, `html2.txt`, `html3.txt`, `html comment list` | axios mặc định dùng XHR |
| tab Network của Chrome ghi XHR cho axios | cùng entry trên | hook `window.fetch` **không bao giờ chạy** |

Bản 1.6.0 có bắt `XMLHttpRequest` nhưng chỉ lưu **url**:

```js
state.listReq = { url: xhr.__rdUrl, init: null };   // mất method + body
```

⇒ Khi tự gọi lại: `pollList` đọc `r.method` = `undefined` → `fetch` mặc định **GET**, không body.
Endpoint là **POST multipart/form-data** ⇒ request hỏng, không có dữ liệu, và vì HAR
`tinnhanmoi.har` có **0** khung `insertMessage` nên radar **không báo được tin nào** — đúng hiện tượng “không hoạt động”.

### 1.7.0 sửa gì

1. **Bắt đầy đủ XMLHttpRequest**: `open` (method + url), `setRequestHeader` (headers), `send` (body),
   và đọc `responseText` ở `load`/`readystatechange` → mọi response danh sách của ứng dụng được nạp vào radar
   **miễn phí, không cần request thêm**.
2. **Gọi lại đúng method + body**: POST giữ POST; nếu body không lấy được thì tự tạo
   `FormData { type: "ALL,UNREAD" }` (đúng `postData` trong HAR) và bỏ header `content-type` để trình duyệt tự sinh boundary.
3. **Không gọi lại request “trang kế tiếp”**: request có `next_cursor` bị bỏ qua (gọi lại chỉ nhận đúng trang đó)
   và chuyển sang request tự dựng.
4. **Tự dựng request khi chưa học được gì**: page id lấy từ URL `/pages/<id>`, từ hội thoại đã biết và từ DOM →
   `POST /api/v1/conversations?pages[<id>]=0&unread_first=true&mode=OR`. Nhờ vậy radar vẫn chạy dù chưa bắt được request nào.
5. **Tự chuyển nguồn khi lỗi**: request của ứng dụng trả HTTP ≥ 400 hai lần → chuyển sang request tự dựng.
6. **Kích hoạt theo giao diện không bị chặn nhịp**: dòng vừa đổi → gọi lại sau 150 ms với ngưỡng riêng 250 ms
   (trước đây bị chặn bởi `pollMinGap` 1200 ms nên tin hiện ra rồi mới báo).
7. **Tự gắn lại giao diện**: nếu SPA dựng lại `body` làm nút 📨/bảng bị gỡ, vòng 4 giây sẽ tạo lại.
8. **Nhìn là biết đang chạy**: tiêu đề có `v1.7.0`, dòng trạng thái có `nguồn XHR POST`, 🔍 có
   `nguồn request: XMLHttpRequest POST — <url>`, `XHR thấy: N`, và nhật ký có `🚀 radar v1.7.0 đang chạy …`.

### Cách kiểm tra trong 30 giây (trong trình duyệt)

1. Cài lại file `userscripts/pancake-new-message-radar.user.js` (bản cũ không tự cập nhật).
2. Mở Pancake, nhìn góc màn hình: nút 📨 và bảng phải có chữ **v1.7.0**.
3. Bấm 🔍, đọc 3 dòng:
   - `nguồn request: XMLHttpRequest POST — /api/v1/conversations?pages[…]` ⇒ đã bắt được request thật;
   - `XHR thấy: N` với N > 0;
   - `request danh sách: N lần · tự gọi lại: M lần · lần cuối: HH:MM:SS` với M tăng đều.
4. Bấm 🧪 → phải hiện ngay một tin thử (chứng minh phần hiển thị chạy).
5. Khách nhắn thật → tin hiện kèm tên, nội dung, vị trí dòng.

Nếu bước 3 ra `nguồn request: chưa học được (sẽ tự dựng)` mà vẫn không có tin: gửi lại nguyên khối 🔍 —
trong đó có sẵn url, số request, lỗi gần nhất để đối chiếu tiếp, không cần đoán.

### Vì sao 1.5.0 vẫn sót tin — bằng chứng trong HAR

Giả định sai ở 1.5.0: *“API danh sách trả về toàn bộ hộp thư”*. Dữ liệu thật nói khác.

`tinnhanmoi.har` → entry `POST /api/v1/conversations` (12 tham số `pages[…]`, `unread_first=true`,
`mode=OR`, `tags=["NO_TAG"]`, `except_tags=[]`, `cursor_mode=true`, body `type=ALL,UNREAD`):

| Đọc được từ response | Giá trị |
|---|---|
| `conversations` | **1** hội thoại (`881264518397934_28856202704022307`, `unread:0`) |
| `pages_with_current_count` | 11 trang = **0**, trang `881264518397934` = **1** |
| `next_cursor` | có → còn trang nữa, script **không** đi hết |

⇒ Danh sách trả về chỉ là **một lát cắt** (lọc tag + `cursor_mode`). Tin của hội thoại nằm ngoài
lát cắt đó **không bao giờ** xuất hiện dù có quét nhanh đến đâu — đây là lý do “tin được tin không”,
không phải do bộ đếm 8 giây.

### 1.6.0 sửa gì

1. **Theo dõi `pages_with_current_count`** — mỗi lần đọc response, so số chưa đọc của từng trang;
   trang nào **tăng** thì gọi riêng trang đó:
   `GET /api/v1/pages/<page_id>/conversations?current_count=20&unread_first=true&mode=OR`
   (giới hạn 3 giây/trang, tự tắt sau 2 lần lỗi). Nhật ký ghi `🔔 trang <id> có N tin chưa đọc (trước M)`.
2. **Hội thoại chưa từng thấy = tin mới** — nếu `updated_at` trong 15 phút; tránh báo cả loạt hội thoại cũ
   khi lần đầu gọi riêng một trang.
3. **Bỏ gộp trùng quá tay** — trước đây cùng psid + cùng nội dung trong 20 giây bị coi là một tin,
   nên khách nhắn lại đúng câu cũ thì im lặng. Nay:
   - hai tin đều từ websocket → so **mã tin (`mid.$…`)** — câu giống nhau vẫn là 2 tin;
   - hai tin đều từ danh sách → so **`updated_at`** — cùng mốc mới là cùng một tin;
   - khác nguồn (ws + danh sách của cùng một tin) → gộp theo nội dung trong 8 giây.
4. **Không tự ăn nhầm request của chính mình** — cờ `state.internal` để các lần tự gọi không ghi đè
   request danh sách đã học từ ứng dụng.

### Ba đường bắt tin — đường nào tới trước thì dùng

| Đường | Độ trễ thực tế | Ghi chú |
|---|---|---|
| websocket `insertMessage` | **trước khi dòng hiện** | chỉ có khi socket Facebook đẩy tin; không phải lúc nào cũng có |
| dòng trên màn hình vừa đổi → gọi lại danh sách NGAY | **~0,15 – 0,5 giây** | bật mặc định (`domTrigger:true`) |
| **trang báo có tin chưa đọc** → gọi riêng trang đó | **≤ 2 giây** | bắt được cả hội thoại ngoài lát cắt của danh sách |
| tự gọi lại danh sách | **≤ 2 giây** | `pollMs: 2000`, chỉ khi tab đang xem |

Bản 1.4.0 quét 8 giây nên “tin hiện ra rồi mới báo”. Nay: dòng vừa đổi là gọi lại API ngay
(150 ms), lấy `last_sent_by` để biết **đúng chiều**, rồi báo — trong bảng ghi rõ độ trễ,
ví dụ `báo sau dòng 0,2s`, còn tin qua websocket ghi `báo TRƯỚC khi dòng hiện`.

### Xác định CHIỀU tin

| Nguồn | Trường | Kết luận |
|---|---|---|
| Khung `insertMessage` | `…,"<mid.…>","<id>",[19,"<SENDER ID>"]` | `= psid` → tin khách · `= page id` → tin shop |
| API danh sách | `last_sent_by` (object) | `id = from_psid` → tin khách · `id = page_id` → tin shop |
| Khung `deleteThenInsertThread` | không có sender | chưa rõ chiều → **không báo** |
| Giao diện | không có trường chiều | chỉ **kích hoạt** gọi API, không tự báo |

### Endpoint danh sách (đã kiểm trong HAR)

- `POST /api/v1/conversations?pages[…]=0&unread_first=true&mode=OR` (body `type=ALL,UNREAD`) — `tinnhanmoi.har`
- `GET /api/v1/pages/<page_id>/conversations?current_count=40&next_cursor=…` — `loaddanhsach.har`

Script ghi nhớ **url + method + body** của request gặp được rồi tự gọi lại; bỏ `content-type`
khi gửi lại FormData để trình duyệt tự sinh boundary.

Vì danh sách nhiều trang chỉ trả một lát cắt, script còn gọi **danh sách riêng của từng trang**
(`/api/v1/pages/<id>/conversations`) khi trang đó báo có tin chưa đọc — xem mục 1.6.0 ở trên.

### Bảng + chẩn đoán

```
WS 1 socket · 12 tin · DS 6 lần (10:22:30) · bỏ 7 tin shop · Tên 300
trang có tin mới: 2 · gọi riêng trang: 2 (lỗi 0)

10:22:41 📥 Ngọc Ánh · Còn size M không shop
10:22:38 ⏭ bỏ tin shop · Dạ em gửi bảng size ngay ạ
10:22:20 🔄 danh sách: 20 hội thoại
```

```js
__radar.debug()              // trạng thái + chẩn đoán + nhật ký
__radar.poll()               // gọi lại danh sách ngay
__radar.set({pollMs:1500})   // nhanh hơn (mặc định 2000)
__radar.set({domTrigger:false})  // tắt kích hoạt theo giao diện
__radar.state                // dữ liệu thô: convs / people / items / pageCounts
```

Kiểm thử trên dữ liệu thật: `node tools/test_radar_real.js` — **19 mục**, chạy DOM thật
(`demo/real_dom_fixture.html`) + payload thật 41 hội thoại (`batmesss.har` → `POST /api/v1/conversations`),
ứng dụng gửi request bằng XMLHttpRequest như thật.

Kiểm thử: `node tools/test_radar.js` — **68 mục**, gồm khung thật #28/#37/#33/#88, endpoint thật
`POST /api/v1/conversations`, kích hoạt theo giao diện (đo được ~0,15 giây), tự gọi lại,
**trang báo có tin chưa đọc → gọi riêng trang và báo đúng khách ngoài trang đầu**, **hai tin trùng nội dung vẫn báo đủ 2 lần** (phân biệt bằng `mid`),
**socket Phoenix của Pancake** (`wss://pancake.vn/socket/websocket?vsn=2.0.0`) và **dạng tin nhắn thật**
(`from.id` + `original_message` + `inserted_at`), kèm kiểm tra tin cũ không bị báo,
**khung `pages:update_conversation`** (đủ dữ liệu → báo ngay; thiếu dữ liệu → gọi riêng trang),
và **nhóm chưa gắn tag** (`tags=["NO_TAG"]` → báo được hội thoại chưa gắn tag).
