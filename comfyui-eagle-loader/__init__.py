"""
ComfyUI Eagle Loader
Browse and load images directly from Eagle library in ComfyUI
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Load any .js files in this directory as a ComfyUI frontend extension.
WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
