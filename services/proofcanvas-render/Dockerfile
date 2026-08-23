FROM manimcommunity/manim@sha256:89ab433ce59134a4dcf351deb2511e067ab354393c0bb7d1859f3e8f0b2406a3 AS proofcanvas-render-base

USER root
WORKDIR /app

COPY requirements.txt requirements.lock /app/
RUN while IFS= read -r requirement; do \
      grep -Fqx "$requirement \\" /app/requirements.lock; \
    done < /app/requirements.txt \
    && /opt/venv/bin/python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
      -r /app/requirements.lock

COPY proofcanvas_render /app/proofcanvas_render
RUN mkdir -p /tmp/proofcanvas-render && chown -R manimuser:manimuser /app /tmp/proofcanvas-render

USER manimuser
ENV HOME=/tmp/proofcanvas-home \
    XDG_CACHE_HOME=/tmp/proofcanvas-home/.cache \
    XDG_CONFIG_HOME=/tmp/proofcanvas-home/.config \
    PROOFCANVAS_RENDER_ROOT=/tmp/proofcanvas-render \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

EXPOSE 8080
CMD ["/opt/venv/bin/uvicorn", "proofcanvas_render.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--no-proxy-headers"]

FROM proofcanvas-render-base AS proofcanvas-render-test

USER root
COPY requirements-test.txt requirements-test.lock /app/
RUN while IFS= read -r requirement; do \
      grep -Fqx "$requirement \\" /app/requirements-test.lock; \
    done < /app/requirements-test.txt \
    && /opt/venv/bin/python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
      -r /app/requirements-test.lock
COPY tests /app/tests
RUN chown -R manimuser:manimuser /app/tests
USER manimuser

FROM proofcanvas-render-base AS proofcanvas-render-runtime
