# Eagle API Usage Notes

[日本語版](eagle-api-usage-notes.ja.md)

This page summarizes important Eagle API behaviors observed while developing and operating Eagle-ComfyUI Integration.

Most users do not need to think about these details during normal use, but they are useful when you want to:

- troubleshoot unexpected behavior
- modify the Eagle plugin side
- extend the ComfyUI custom nodes
- build another integration that uses the Eagle API

The Eagle API is useful, but returned data and available functions can vary depending on the Eagle version and runtime environment.  
This project normalizes and validates data on the Bridge side as much as possible to absorb those differences.

---

## Quick reference

A summary of each note. See the matching section below for details.

| #  | Topic | Takeaway |
|----|-------|----------|
| 1  | Validate item paths | Match `filePath` / `thumbnailPath` against the item ID before use |
| 2  | Serialize item reads | Don't over-parallelize image-path operations |
| 3  | `thumbnailPath` handling | Validate / refetch; include the item ID in cache keys |
| 4  | `folder.getAll()` variance | Normalize the response shape (array / tree / field names) on the Bridge |
| 5  | Folder selection | Prefer folder IDs over names |
| 6  | Missing item fields | Access them defensively with `.get()` |
| 7  | Live updates | Feature-check functions; disable when absent |
| 8  | `onLibraryChanged` | Notify only when the path actually changes |
| 9  | Library switching | Not via API; assume it happens in the Eagle UI |
| 10 | Adding images | Prefer `addFromPath` for local setups |
| 11 | Timeouts | Always set them on API calls |
| 12 | Japanese filenames | Don't put them raw in headers; UTF-8 encode |
| 13 | `nativeImage` | Don't resize when it's unavailable |
| 14 | Normalize on the Bridge | Don't depend on raw data; normalize before returning |
| 15 | Extending the project | Enforce ID matching, ID-first, missing fields, timeouts |

---

## 1. Validate item `filePath` / `thumbnailPath` before using them

**In short: always match `filePath` / `thumbnailPath` against `item.id`, refetch on a mismatch, and never return the wrong image.**

Eagle items may include the following values for the original image and thumbnail paths:

- `filePath`
- `thumbnailPath`

Normally, these paths point inside the item's own `.info` folder.

Example:

```text
.../images/ITEM_ID.info/image.png
.../images/ITEM_ID.info/image_thumbnail.png
```

However, depending on the environment or timing, Eagle may return a path that belongs to a different item from the requested item ID.

For example:

```text
requested item id: A
returned thumbnailPath: .../B.info/image_thumbnail.png
```

If that path is used as-is, the UI may display the thumbnail or image for a different item.

For this reason, this project checks that:

- `item.id` matches the requested ID
- `filePath` is under that item's `.info` folder
- `thumbnailPath` is under that item's `.info` folder

If a mismatch is detected, the Bridge retries the read. If the data is still invalid, it avoids returning the wrong image.

---

## 2. Do not over-parallelize item reads

**In short: serialize item reads in image-path operations and validate the returned paths.**

When displaying many thumbnails, it is tempting to fetch multiple items concurrently.

However, when Eagle Plugin API item reads are executed with high concurrency, some environments have shown behavior that looks like partial item data being mixed together.

Example:

```text
item.id is correct
but filePath / thumbnailPath belongs to another item
```

For this reason, the Bridge serializes item reads in important image-path-related operations.

Examples:

- thumbnail retrieval
- original image retrieval
- workflow metadata extraction
- `Load WF`
- image retrieval during ComfyUI node execution

Parallelism does not need to be avoided completely, but any operation that uses image paths should validate the returned data.

---

## 3. `thumbnailPath` is convenient, but do not trust it too much

**In short: treat `thumbnailPath` as needing validation / refetch, and include the item ID and path in cache keys.**

`thumbnailPath` is useful for lightweight preview display.

However, as described above, it may point to a different item. This project handles it as follows:

1. Get `thumbnailPath`.
2. Check that the path is under the current item ID's `.info` folder.
3. Retry if there is a problem.
4. If the path is still invalid, do not return the wrong image.

When using a cache for faster thumbnail display, use a collision-resistant key that includes the item ID and path.

---

## 4. `folder.getAll()` can return different shapes

**In short: the response shape (array / tree / field names) varies, so normalize it on the Bridge side.**

The Eagle folder list API may return different data shapes depending on the environment.

For example, it may return a simple array:

```js
[
  { id: "...", name: "Parent" }
]
```

Or it may return a tree:

```js
[
  {
    id: "...",
    name: "Parent",
    children: [
      {
        id: "...",
        name: "Child"
      }
    ]
  }
]
```

Some environments may also use alternative field names.

### Possible ID fields

- `id`
- `folderId`
- `folder_id`
- `uuid`
- `_id`

### Possible name fields

- `name`
- `folderName`
- `folder_name`
- `title`
- `label`

### Possible parent folder fields

- `parent`
- `parentId`
- `parent_id`
- `pid`

This project normalizes folder information on the Bridge side and converts child and grandchild folders into path-like labels such as:

```text
Parent
Parent/Child
Parent/Child/Grandchild
```

This lets the ComfyUI side treat nested folders as ordinary selectable options.

---

## 5. Prefer folder IDs when specifying folders

**In short: specify folders by ID, not name (path labels are for UI display only).**

Eagle may allow multiple folders with the same name.

For this reason, internal processing prioritizes folder IDs over folder names.

For clarity, the UI displays folders like this:

```text
Parent/Child [folderId]
```

Users can choose by looking at the path, but the actual operation uses the ID.

String path selection is supported, but ID-based selection is safer.

---

## 6. Item fields are not guaranteed to exist

**In short: item fields may be missing, so access them defensively with `.get()` or equivalent.**

Eagle items can contain many fields.

Examples:

- `name`
- `tags`
- `star`
- `annotation`
- `folders`
- `width`
- `height`
- `filePath`
- `thumbnailPath`

However, depending on the API call or Eagle state, some fields may be missing.

For this reason, the Python and JavaScript code in this project uses defensive access patterns such as:

```python
item.get("star", 0)
item.get("tags", [])
item.get("annotation", "")
```

Direct access can fail if the key is missing.

```python
item["star"]  # error if star is missing
```

When extending or modifying the project, item fields should also be handled safely with `.get()` or equivalent patterns.

---

## 7. Live updates depend on the Eagle version

**In short: feature-check Live updates functions and disable them when absent; normal features keep working.**

This project may use Live updates to detect changes in the Eagle library.

However, some functions may not exist depending on the Eagle version.

Example:

```text
eagle.item.getIdsWithModifiedAt is not a function
```

For this reason, the Bridge checks whether functions exist before using them, and disables Live updates when they are not available.

Normal search, display, and loading features remain available in that case.

---

## 8. `onLibraryChanged` may fire even when the library did not actually change

**In short: notify the ComfyUI side only when the library path actually changes.**

Eagle provides an event for detecting library switches.

However, it may fire during initial connection or even when the same library is still open.

This project handles that behavior as follows:

- store the first notification as a baseline
- ignore notifications that match the current library path
- notify the ComfyUI side only when the path actually changes

This prevents unnecessary `Library changed.` messages.

---

## 9. Do not switch Eagle libraries through the API

**In short: library switching is assumed to happen in the Eagle UI; ComfyUI only detects it and prompts a refresh.**

Eagle can manage multiple libraries.

The current library information can be read.

Examples:

- library name
- library path
- library info

However, the following operations have not been confirmed as official API features:

- listing all libraries
- switching libraries through the API
- opening a specified library through the API

For this reason, this project assumes that library switching is done in the Eagle UI.

On the ComfyUI side, if a library change is detected, the user is prompted to refresh.

---

## 10. `addFromPath` is usually the most stable way to add images

**In short: prefer `addFromPath` for local setups; use `addFromURL` / `addFromBase64` as fallbacks.**

There are several ways to add images generated by ComfyUI to Eagle.

### addFromPath

Use this when ComfyUI and Eagle are running on the same PC.

ComfyUI passes the local file path of the saved image to Eagle.

```text
Eagle and ComfyUI are on the same PC
  -> addFromPath
```

This method is usually the most stable, so it is the default for `Eagle Quick Send to Eagle`.

---

### addFromURL

Use this when Eagle can access the ComfyUI image URL.

```text
Eagle can read the ComfyUI URL
  -> addFromURL
```

This can be useful for remote or multi-machine setups.

However, in some environments the call did not return, so `addFromPath` is recommended for local setups.

---

### addFromBase64

This method sends the image data from ComfyUI to Eagle as Base64.

```text
URL access is not possible
  -> addFromBase64
```

It can be used as a fallback for remote setups.

However, large images produce a lot of data, and in some environments the Eagle-side operation did not return.

---

## 11. Add timeouts to Eagle API calls

**In short: some calls may never return, so always set a timeout on API calls.**

Some Eagle API operations may not return depending on the environment.

Observed examples:

- `addFromURL`
- `addFromBase64`

For this reason, the Bridge sets timeouts for API calls.

Without a timeout, the Eagle plugin side may appear to hang.

---

## 12. Do not put Japanese filenames directly into HTTP headers

**In short: don't put Japanese filenames in headers directly; use an ASCII fallback plus `filename*=UTF-8''`.**

Eagle can handle Japanese filenames, tags, and folder names normally.

However, putting Japanese text directly into a Node.js HTTP header can cause errors.

Example:

```text
Invalid character in header content ["Content-Disposition"]
```

For this reason, this project uses the following style when returning `Content-Disposition`:

```http
Content-Disposition: inline; filename="fallback.png"; filename*=UTF-8''...
```

- put an ASCII fallback name in `filename`
- put the UTF-8 encoded name in `filename*`

---

## 13. `nativeImage` is not available in every environment

**In short: when `nativeImage` is unavailable, return the original thumbnail without resizing.**

Eagle is based on Electron, but Electron's `nativeImage` is not always available in the plugin runtime.

If thumbnail resizing tries to use `nativeImage`, some environments cannot use it.

For this reason, this project returns the original thumbnail without resizing when `nativeImage` is unavailable.

---

## 14. Normalize data on the Bridge side before returning it to ComfyUI

**In short: don't depend on raw Eagle data — normalize it on the Bridge side before returning it to ComfyUI.**

Because Eagle API responses can vary, the ComfyUI side becomes more fragile if it depends too directly on raw Eagle data.

This project tries to perform the following work on the Bridge side:

- normalize item information
- normalize folder information
- validate paths
- flatten folder hierarchies
- check API feature availability
- apply timeouts
- shape errors into consistent responses

The ComfyUI side is designed to use the relatively stable data returned by the Bridge.

---

## 15. Recommended approach when extending the project

**In short: enforce item-ID matching, ID-first folders, missing-field handling, and timeouts to stay stable while extending.**

When adding new features that use the Eagle API, the following practices are recommended.

### When handling items

- always verify `item.id`
- compare `filePath` / `thumbnailPath` against the item ID
- handle missing fields
- serialize reads when necessary

### When handling folders

- prefer IDs
- treat path labels as UI display values
- recursively expand `children`
- handle field-name variations

### When adding images

- prefer `addFromPath` for local setups
- consider `addFromURL` for remote setups
- use `addFromBase64` as a fallback
- always set a timeout

### When using Live updates

- check whether functions exist
- keep normal features usable in unsupported environments

---

## Summary

The Eagle API is powerful, but returned data and available functions can differ by environment.

This project improves stability with the following principles:

- do not trust Eagle API results blindly
- normalize data on the Bridge side
- compare paths against item IDs
- flatten folder hierarchies on the Bridge side
- add timeouts to API calls
- prefer `addFromPath` for local image additions

These measures help ComfyUI handle Eagle images, tags, folders, and metadata in a more stable form.
