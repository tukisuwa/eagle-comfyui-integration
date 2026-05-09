# Browse and Load Images

Use `Eagle Image Browser` to search Eagle and load a selected item into ComfyUI.

## Eagle Image Browser

Outputs:

- `image`: the image tensor for ComfyUI.
- `file_path`: the original file path when available.
- `metadata_json`: Eagle item information such as ID, name, tags, rating, annotation, and dimensions.

You can pass `metadata_json` to nodes such as `Eagle Quick Update Item` or `Eagle Extract Embedded Workflow`.

## Gallery

Click `Open Gallery` on the node.

The gallery lets you:

- Search by keyword.
- Filter by tags.
- Filter by folder.
- Filter by star rating.
- Select images from thumbnails.
- View the original image.
- Open the item in Eagle.
- Load embedded ComfyUI workflows.

When you select an image, the node updates its selected state. Usually you do not need to edit `selected_item_json` manually.

## selected_index

`selected_index` is a zero-based position in the current search result.

If you change the search filters, the same index may point to a different item. Use the gallery when you want to choose a specific item visually.

## index_mode

`index_mode` controls what happens to `selected_index` after a node run:

- `fixed`: keep the same index.
- `increment`: move to the next item.
- `decrement`: move to the previous item.
- `random`: choose a random next index.

Use `increment` when you want repeated runs to step through Eagle images.

## Helper Loader Nodes

`Eagle Image by ID` loads one item when you already know its item ID.

`Eagle Random Image` selects one item from matching search conditions using `seed`.

