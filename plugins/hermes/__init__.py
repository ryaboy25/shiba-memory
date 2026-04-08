"""Shiba Memory plugin for Hermes Agent."""

from .memory_provider import ShibaMemoryProvider


def register(ctx):
    """Register the Shiba memory provider with Hermes."""
    ctx.register_memory_provider(ShibaMemoryProvider())
