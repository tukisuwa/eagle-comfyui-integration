# Update Eagle Item Metadata

Use update nodes to edit existing Eagle items from ComfyUI.

Start with `Eagle Quick Update Item`.

## metadata_json

Loader nodes such as `Eagle Image Browser` output `metadata_json`.

It contains the Eagle item ID and other item information. Passing it to an update node tells the node which item to update.

## Eagle Quick Update Item

Common inputs:

- `metadata_json`: item metadata from a loader node.
- `item_id`: direct item ID when you do not use metadata.
- `star`: rating. `-1` means no change.
- `tags_add_csv`: tags to add.
- `tags_remove_csv`: tags to remove.
- `annotation_append`: text to append to annotation.
- `folder`: destination folder. Empty means no folder change.
- `trash`: move item to trash.
- `confirm_trash`: confirmation for trash operation.

Enable `confirm_trash` when using `trash`.

## Eagle Update Item

Use the full update node when you need:

- Replace all tags.
- Replace annotation.
- Toggle star.
- Clear folder.
- Keep using older workflows without rewiring their inputs.

The first output is also `metadata_json`, so it can be passed to later Eagle metadata nodes.
