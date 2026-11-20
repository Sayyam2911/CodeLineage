"""Start the HTTP service on the port supplied by the container platform."""

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run("codelineage.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
