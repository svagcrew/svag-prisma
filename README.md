$ psql

create database "svag-prisma";
create user "svag-prisma" with encrypted password 'svag-prisma';
grant all privileges on database "svag-prisma" to "svag-prisma";
alter user "svag-prisma" createdb;
alter database "svag-prisma" owner to "svag-prisma";

$ touch .env && code .env

DATABASE_URL=postgresql://svag-prisma:svag-prisma@localhost:5432/svag-prisma?schema=public

$ pnpm pgc
