# Embedded Workflows and Metadata

Some ComfyUI PNG images contain embedded workflow or prompt metadata.

These nodes can read that information from Eagle items.

## Load From the Gallery

The easiest path is to open `Eagle Image Browser`, select an item, then click `Load WF`.

This reads the original Eagle image and loads its embedded ComfyUI workflow into the current ComfyUI page.

## Eagle Extract Embedded Workflow

Use this node when you want the embedded data as JSON strings.

Inputs:

- `item_id`: Eagle item ID.
- `metadata_json`: metadata from a loader node.

Outputs:

- `workflow_json`: ComfyUI workflow.
- `prompt_json`: prompt data.
- `keys_json`: metadata keys found in the image.

Usually, connect `metadata_json` from `Eagle Image Browser`.

## When No Workflow Is Found

Not every image contains workflow metadata.

Check that:

- The image was saved from ComfyUI.
- You are reading the original image, not a thumbnail.
- The metadata was not stripped before the image was added to Eagle.

