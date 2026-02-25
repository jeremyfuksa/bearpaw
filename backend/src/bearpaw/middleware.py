from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response


def add_cors_middleware(app):
    """
    Add CORS middleware to the FastAPI application.

    This allows the frontend (running on port 5173) to make API requests
    to the backend (running on port 8000).
    """
    origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Add a simple OPTIONS handler to preflight requests
    @app.options("/{path:path}")
    async def options_handler(path: str, request: Request) -> Response:
        return Response(
            status_code=200,
            headers={
                "Access-Control-Allow-Origin": request.headers.get("origin", "*"),
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Credentials": "true",
            },
        )
