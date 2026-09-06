# Fallback image, NOT used by default. The stack normally runs the author's
# official image (gilleslamiral/imapsync, pinned in compose.yaml). Build this
# one instead when:
#   - the host is arm64 (the official image is amd64-only), or
#   - the official image's base (debian:bullseye, EOL) becomes a concern.
#
# Usage: in a forwarder service, replace the "image:" line
# with "build: ." and run `docker compose build`.
#
# Derived from the author's Dockerfile (https://imapsync.lamiral.info/INSTALL.d/Dockerfile)
# on a current Debian base, trimmed to what this stack needs: no servimapsync
# web UI, no OAuth2 helpers, no PAR packer.

FROM debian:bookworm-slim

ARG IMAPSYNC_VERSION=2.314

LABEL description="imapsync for laposte_forwarder (local fallback build)" \
      documentation="https://imapsync.lamiral.info/#doc"

# Runtime dependency list from the author's INSTALL.d for Debian 12, plus
# bash/procps/ca-certificates/wget used by bin/laposte-forward and debugging.
RUN set -xe \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        cpanminus \
        libauthen-ntlm-perl \
        libcgi-pm-perl \
        libcrypt-openssl-pkcs12-perl \
        libcrypt-openssl-rsa-perl \
        libdata-uniqid-perl \
        libemail-address-perl \
        libencode-imaputf7-perl \
        libfile-copy-recursive-perl \
        libfile-tail-perl \
        libhtml-parser-perl \
        libhttp-daemon-perl \
        libhttp-daemon-ssl-perl \
        libhttp-message-perl \
        libio-compress-perl \
        libio-socket-inet6-perl \
        libio-socket-ssl-perl \
        libio-tee-perl \
        libjson-webtoken-perl \
        libmail-imapclient-perl \
        libmodule-scandeps-perl \
        libnet-dns-perl \
        libnet-server-perl \
        libparse-recdescent-perl \
        libproc-processtable-perl \
        libreadonly-perl \
        libregexp-common-perl \
        libsys-meminfo-perl \
        libterm-readkey-perl \
        libtest-deep-perl \
        libtest-mockobject-perl \
        libtest-pod-perl \
        libunicode-string-perl \
        liburi-perl \
        libwww-perl \
        make \
        procps \
        wget \
    && rm -rf /var/lib/apt/lists/*

# Version-pinned imapsync script from the author's release archive.
# `imapsync --tests` runs the offline self-test suite; the author's build also
# runs --testslive, skipped here to avoid depending on his test servers.
RUN set -xe \
    && wget -O /usr/bin/imapsync \
        "https://imapsync.lamiral.info/dist2/old_releases/${IMAPSYNC_VERSION}/imapsync" \
    && chmod +x /usr/bin/imapsync \
    && imapsync --version \
    && imapsync --tests

# Match the official image: unprivileged user, writable HOME for imapsync.
USER nobody:nogroup
ENV HOME=/var/tmp
WORKDIR /var/tmp

STOPSIGNAL SIGINT

CMD ["/usr/bin/imapsync"]
