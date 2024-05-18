/* eslint-disable prefer-spread */

// WE CAN NOT IMPORT IT. IT IS LIB PACKAGE, NOT A PROJECT PACKAGE
// JUST UNCOMMENT TO CHECK TYPES
// import type { Prisma, PrismaClient } from '@prisma/client'
import { backOff, type IBackOffOptions } from 'exponential-backoff'

// JUST UNCOMMENT TO CHECK TYPES
// export const createPrismaThings = <
//   TPrisma extends typeof Prisma,
//   TPrismaClient extends typeof PrismaClient,
//   TEnv extends Record<string, any> | undefined,
// >({
export const createPrismaThings = <
  TPrisma,
  TPrismaClient extends abstract new (...args: any) => any,
  TEnv extends Record<string, any> | undefined,
>({
  Prisma,
  PrismaClient,
  env,
  logger = console,
  overridePrismaClientOptions = {},
  isTestDatabase = (env) => env?.HOST_ENV === 'test' && env?.DATABASE_URL?.includes('-test'),
  logQueryParams = (env) => env?.HOST_ENV === 'local',
}: {
  Prisma: TPrisma
  PrismaClient: TPrismaClient
  env?: TEnv
  logger?: { info: (props: any) => any; error: (props: any) => any }
  overridePrismaClientOptions?: ConstructorParameters<TPrismaClient>[0]
  isTestDatabase?: (env: TEnv) => boolean
  logQueryParams?: (env: TEnv) => boolean
}) => {
  // JUST UNCOMMENT TO CHECK TYPES
  // const PrismaInternal = Prisma
  const PrismaInternal = Prisma as any
  // JUST UNCOMMENT TO CHECK TYPES
  // const PrismaClientInternal = PrismaClient
  const PrismaClientInternal = PrismaClient as any
  type PrismaClientInstanceInternal = ReturnType<typeof createPrismaClient>

  const getAllPrismaModelsNames = (prisma: PrismaClientInstanceInternal) => {
    return Object.keys(prisma)
      .filter((modelName) => !modelName.startsWith('_') && !modelName.startsWith('$'))
      .map((modelName) => modelName.charAt(0).toUpperCase() + modelName.slice(1))
  }

  const setFakeCreatedAtForAllRecords = async (prisma: PrismaClientInstanceInternal, now?: Date) => {
    if (!isTestDatabase(env as any)) {
      return
    }
    const modelsNames = getAllPrismaModelsNames(prisma)
    const nowISO = (now || new Date()).toISOString()
    for (const modelName of modelsNames) {
      if (modelName === 'TestCreatedAtLog') {
        continue
      }
      // Create table TestCreatedAtLog if it does not exist
      await prisma.$executeRawUnsafe(`
        create table if not exists "TestCreatedAtLog" (
          "id" text primary key,
          "originalCreatedAt" timestamp with time zone not null,
          "desiredCreatedAt" timestamp with time zone not null,
          "recordId" text not null,
          "modelName" text not null
        );
      `)
      // Create a new record in TestCreatedAtLog with the originalCreatedAt and desiredCreatedAt set to now based on records in the model which do not have a corresponding record in TestCreatedAtLog
      await prisma.$executeRawUnsafe(`
        insert into "TestCreatedAtLog" ("id", "originalCreatedAt", "desiredCreatedAt", "recordId", "modelName")
        select md5(random()::text), "${modelName}"."createdAt", '${nowISO}', "${modelName}"."id", '${modelName}' from "${modelName}" where not exists (select 1 from "TestCreatedAtLog" where "TestCreatedAtLog"."modelName" = '${modelName}' and "TestCreatedAtLog"."recordId" = "${modelName}"."id");
      `)
      // Update the createdAt of the records in the model to now for that records which exists in TestCreatedAtLog but where TestCreatedAtLog.desiredCreatedAt is not equal to Model.createdAt
      await prisma.$executeRawUnsafe(`
        update "${modelName}" set "createdAt" = '${nowISO}' where exists (select 1 from "TestCreatedAtLog" where "TestCreatedAtLog"."modelName" = '${modelName}' and "TestCreatedAtLog"."recordId" = "${modelName}"."id" and "TestCreatedAtLog"."desiredCreatedAt" != "${modelName}"."createdAt");
      `)
    }
  }

  const RetryTransactions = (options?: Partial<IBackOffOptions>) => {
    return PrismaInternal.defineExtension((prisma: any) =>
      prisma.$extends({
        client: {
          $transaction: async (...args: any) => {
            return await backOff(() => prisma.$transaction.apply(prisma, args), {
              retry: (e) => {
                // Retry the transaction only if the error was due to a write conflict or deadlock
                // See: https://www.prisma.io/docs/reference/api-reference/error-reference#p2034
                return e.code === 'P2034'
              },
              ...options,
            })
          },
        } as { $transaction: (typeof prisma)['$transaction'] },
      })
    )
  }

  const createPrismaClient = () => {
    const prisma = new PrismaClientInternal({
      transactionOptions: {
        maxWait: 10_000,
        timeout: 10_000,
        isolationLevel: PrismaInternal.TransactionIsolationLevel.Serializable,
      },
      log: [
        {
          emit: 'event',
          level: 'query',
        },
        {
          emit: 'event',
          level: 'info',
        },
      ],
      ...(overridePrismaClientOptions as {}),
    })

    prisma.$on('query', (e: any) => {
      logger.info({
        tag: 'prisma:low:query',
        message: 'Successfull request',
        meta: {
          query: e.query,
          duration: e.duration,
          params: logQueryParams(env as any) ? e.params : '***',
        },
      })
    })

    prisma.$on('info', (e: any) => {
      logger.info({ tag: 'prisma:low:info', message: e.message })
    })

    let extendedPrisma = prisma.$extends({
      query: {
        $allModels: {
          // JUST UNCOMMENT TO CHECK TYPES
          // $allOperations: async (props: any) => {
          $allOperations: async (props: any) => {
            const { model, operation, args, query } = props
            const isTransaction = !!(props as any).__internalParams?.transaction
            const start = Date.now()
            try {
              const result = await query(args)
              const durationMs = Date.now() - start
              logger.info({
                tag: 'prisma:high',
                message: 'Successfull request',
                meta: { model, operation, args, durationMs },
              })
              const setFakeCreatedAtForAllRecordsPromise = setFakeCreatedAtForAllRecords(
                prisma as PrismaClientInstanceInternal,
                new Date()
              )
              if (!isTransaction) {
                await setFakeCreatedAtForAllRecordsPromise
              }
              return result
            } catch (error) {
              const durationMs = Date.now() - start
              logger.error({ tag: 'prisma:high', error, meta: { model, operation, args, durationMs } })
              const setFakeCreatedAtForAllRecordsPromise = setFakeCreatedAtForAllRecords(
                prisma as PrismaClientInstanceInternal,
                new Date()
              )
              if (!isTransaction) {
                await setFakeCreatedAtForAllRecordsPromise
              }
              throw error
            }
          },
        },
      },
    })

    extendedPrisma = extendedPrisma.$extends(
      RetryTransactions({
        jitter: 'full',
        numOfAttempts: 5,
      })
    )

    return extendedPrisma
  }

  return {
    createPrismaClient: createPrismaClient as () => InstanceType<TPrismaClient>,
    getAllPrismaModelsNames,
  }
}

export type AppPrismaTypeGenerator<T extends ReturnType<typeof createPrismaThings>['createPrismaClient']> =
  ReturnType<T>
export type CuttedPrismaTypeGenerator<T extends ReturnType<typeof createPrismaThings>['createPrismaClient']> = Omit<
  ReturnType<T>,
  '$extends' | '$transaction' | '$disconnect' | '$connect'
>
