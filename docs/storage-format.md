# 相册存储格式

当前格式版本为 `schemaVersion: 1`。公开发行版初次启动没有预装照片，用户通过“新建相册”选择保存位置，再自行添加照片。

## 文件夹结构

每本相册在用户选择的父目录下建立独立文件夹。照片、预览和缩略图都存放在这个相册文件夹内：

```text
我的相册/
├── photobook.json
├── photobook.json.bak       # 保存时保留的上一份描述文件
├── photos/
│   ├── <照片 UUID>.jpg      # 导入原图的副本
│   ├── <照片 UUID>.nef      # 导入 NEF 原文件的副本
│   └── <照片 UUID>-preview.jpg
├── thumbnails/
│   └── <照片 UUID>.jpg
└── pages/                  # 为旧格式兼容保留，当前相机界面不生成页面
```

`photos` 中的副本通过字节数与 SHA-256 校验。导入来源文件保持原样。不同照片使用独立 UUID，原始文件名只作为描述信息保存，重名照片不会互相覆盖。

NEF 的阅读预览也在 `photos` 内，没有独立的 `previews` 文件夹。缩略图缺失时，界面会使用对应原图或 NEF 预览；NEF 的预览文件缺失则无法正常打开相册。

## 项目描述文件

`photobook.json` 是 UTF-8 JSON。以下内容仅为人工构造的示例，不附带照片文件：

```json
{
  "schemaVersion": 1,
  "id": "11111111-1111-4111-8111-111111111111",
  "title": "我的相册",
  "coverPhotoId": "22222222-2222-4222-8222-222222222222",
  "selectedPhotoId": "22222222-2222-4222-8222-222222222222",
  "filmLook": "original",
  "photoOrder": ["22222222-2222-4222-8222-222222222222"],
  "photoEdits": {
    "22222222-2222-4222-8222-222222222222": {
      "caption": "示例说明",
      "rotation": 0
    }
  },
  "photos": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "name": "example.jpg",
      "file": "22222222-2222-4222-8222-222222222222.jpg",
      "thumbnail": "22222222-2222-4222-8222-222222222222.jpg",
      "width": 1600,
      "height": 1200
    }
  ],
  "pages": [],
  "renderedPages": [],
  "readingPage": 0,
  "updatedAt": 0
}
```

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 存储格式版本；当前读取器接受 `1`。 |
| `id`、`title` | 相册标识和名称。 |
| `photos` | 照片登记列表；每项的 `id` 用于排序、说明和选择关联。 |
| `photoOrder` | 阅读顺序，由照片 ID 组成。 |
| `photoEdits` | 按照片 ID 保存说明和旋转参数，不覆盖原图。 |
| `rotation` | 顺时针旋转的四分之一圈数，取值 `0`、`1`、`2`、`3`。 |
| `filmLook` | `original` 原色、`warm` 暖调、`bw` 黑白；仅影响显示。 |
| `selectedPhotoId` | 最近选中的照片。 |
| `coverPhotoId` | 相册代表照片。 |
| `updatedAt` | 最近修改时间，单位为 Unix 毫秒。 |
| `pages`、`renderedPages`、`readingPage` | 保留的旧阅读器兼容字段；新相册的页面数组为空。 |

照片项的 `file` 相对于 `photos/`，`thumbnail` 相对于 `thumbnails/`。NEF 项还包含 `previewFile`、`previewWidth`、`previewHeight`、`orientation`。导入时会记录 `sourceName`、`sourceSize`、`sourceSha256` 和副本的 `size` 等信息，供来源识别和校验使用。

## NEF 显示方式

应用复制 NEF 原文件，并提取其中可解码的内嵌 JPEG 作为阅读预览，按照方向信息处理 JPEG 预览的 EXIF。原 NEF 不会被修改。

这项功能没有执行 RAW 显影或调色处理；照片细节、色彩和预览分辨率受相机写入的 JPEG 限制。没有有效内嵌 JPEG 的 NEF 会导入失败，其他有效照片可以继续导入。

## 保存、移除与迁移

保存时先写临时 JSON，再替换主文件；保存已有相册时尝试保留 `photobook.json.bak`。主文件损坏时不会自动读取备份，恢复前应先保留整个文件夹副本。

“从相册移除”只移除登记和编辑信息，保留来源照片及相册内已经复制的文件。这些保留文件会继续占用磁盘空间。

迁移或备份时应复制整个相册文件夹。重新打开应用后选择新位置的相册文件夹，即可根据相对路径读取照片；最近打开列表中的旧位置可能失效。

## 应用缓存与隐私

相册保存位置由用户决定。应用自己的最近列表、会话、日志和缓存放在当前 Windows 用户的应用数据目录下的 `ShiguangFilm` 文件夹，和相册文件夹分开。

最近列表包含用户选过的绝对相册路径；相册描述文件包含原文件名和说明。原图也可能带有 EXIF 或位置等元数据。分享相册文件夹会同时分享这些资料，应按自己的意愿选择分享范围。

应用没有账号、云同步或照片上传功能。GitHub 源码和公开安装包不包含用户相册、原图、预览或最近列表。

格式实现见 [`electron/main.cjs`](../electron/main.cjs)、[`electron/nef.cjs`](../electron/nef.cjs) 与 [`src/workspace.js`](../src/workspace.js)。

