FROM php:8.3-fpm-alpine
RUN apk add --no-cache libpq postgresql-dev \
  && docker-php-ext-install pdo_pgsql \
  && apk del postgresql-dev
COPY index.php /var/www/html/index.php
COPY fpm.conf /usr/local/etc/php-fpm.d/zz-polyglot.conf
RUN chown -R www-data:www-data /var/www/html
EXPOSE 9000
