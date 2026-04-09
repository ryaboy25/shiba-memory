from setuptools import setup

setup(
    name="shiba-memory",
    version="0.2.0",
    description="Python SDK for Shiba Memory — persistent memory for AI agents",
    author="Ilya Ryaboy",
    py_modules=["shiba_memory"],
    install_requires=["httpx>=0.27"],
    python_requires=">=3.10",
)
