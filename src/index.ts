/* eslint-disable prefer-spread */

// import type { Prisma, PrismaClient } from '@prisma/client'
// WE CAN NOT IMPORT IT. IT IS LIB PACKAGE, NOT A PROJECT PACKAGE
import { type IBackOffOptions, backOff } from 'exponential-backoff'

// type LikePrismaClient = {
//   $executeRawUnsafe: (query: string) => Promise<any>
//   $on: (event: 'query' | 'info' | 'warn' | 'error', cb: (event: any) => any) => any
//   $transaction: <T>(input: any, options?: any) => Promise<T>
//   $extends: (
//     props:
//       | {
//           query: {
//             $allModels: {
//               $allOperations: (props: { model: string; operation: string; args: any; query: (args: any) => any }) => any
//             }
//           }
//         }
//       | { client: { $transaction: any } }
//   ) => any
// }
// type LikePrisma = {
//   defineExtension: (callback: (prisma: LikePrismaClient) => any) => any
//   TransactionIsolationLevel: {
//     Serializable: 'Serializable'
//   }
// }
// type LikePrismaClientConstructor<T extends LikePrismaClient> = new (options?: any) => T

// export const createPrismaThings = <TPrisma extends typeof Prisma, TPrismaClient extends typeof PrismaClient>({
// export const createPrismaThings = <
//   TPrisma extends LikePrisma,
//   TPrismaClient extends LikePrismaClientConstructor<LikePrismaClient>,
// >({
export const createPrismaThings = <TPrisma, TPrismaClient extends abstract new (...args: any) => any>({
  env,
  logger,
  Prisma,
  PrismaClient,
}: {
  env: { HOST_ENV: string; DATABASE_URL: string }
  logger: { info: (props: any) => any; error: (props: any) => any }
  Prisma: TPrisma
  PrismaClient: TPrismaClient
}) => {
  const isTestDatabase = () => {
    return env.HOST_ENV === 'test' && env.DATABASE_URL.endsWith('-test')
  }

  const getAllPrismaModelsNames = (prisma: InstanceType<TPrismaClient>) => {
    return Object.keys(prisma)
      .filter((modelName) => !modelName.startsWith('_') && !modelName.startsWith('$'))
      .map((modelName) => modelName.charAt(0).toUpperCase() + modelName.slice(1))
  }

  const setFakeCreatedAtForAllRecords = async (prisma: InstanceType<TPrismaClient>, now?: Date) => {
    if (!isTestDatabase()) {
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

  function RetryTransactions(options?: Partial<IBackOffOptions>) {
    return (Prisma as any).defineExtension((prisma: any) =>
      prisma.$extends({
        client: {
          $transaction(...args: any) {
            return backOff(() => prisma.$transaction.apply(prisma, args), {
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
    const prisma = new (PrismaClient as any)({
      transactionOptions: {
        maxWait: 10000,
        timeout: 10000,
        isolationLevel: (Prisma as any).TransactionIsolationLevel.Serializable,
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
    })

    prisma.$on('query', (e: any) => {
      logger.info({
        tag: 'prisma:low:query',
        message: 'Successfull request',
        meta: {
          query: e.query,
          duration: e.duration,
          params: env.HOST_ENV === 'local' ? e.params : '***',
        },
      })
    })

    prisma.$on('info', (e: any) => {
      logger.info({ tag: 'prisma:low:info', message: e.message })
    })

    let extendedPrisma = prisma.$extends({
      query: {
        $allModels: {
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
              const setFakeCreatedAtForAllRecordsPromise = setFakeCreatedAtForAllRecords(prisma as any, new Date())
              if (!isTransaction) {
                await setFakeCreatedAtForAllRecordsPromise
              }
              return result
            } catch (error) {
              const durationMs = Date.now() - start
              logger.error({ tag: 'prisma:high', error, meta: { model, operation, args, durationMs } })
              const setFakeCreatedAtForAllRecordsPromise = setFakeCreatedAtForAllRecords(prisma as any, new Date())
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
