import mongoose, { Model, FilterQuery, UpdateQuery, QueryOptions, PopulateOptions } from 'mongoose';

export interface PaginationOptions {
  page?: number;
  limit?: number;
  sort?: Record<string, 1 | -1> | string;
  populate?: string | PopulateOptions | (string | PopulateOptions)[];
}

export interface PaginatedResult<T> {
  docs: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * BaseTenantRepository enforces strict tenant isolation at the data access boundary.
 * Structurally impossible to query without an organizationId.
 */
export abstract class BaseTenantRepository<T> {
  constructor(protected readonly model: Model<T>) {}

  private buildIdFilter(organizationId: string, id: string): FilterQuery<T> {
    if (mongoose.Types.ObjectId.isValid(id)) {
      return {
        organizationId,
        $or: [
          { _id: new mongoose.Types.ObjectId(id) },
          { _id: id },
          { leadId: id },
          { taskId: id },
        ],
      } as FilterQuery<T>;
    }
    return {
      organizationId,
      $or: [
        { employeeId: id },
        { leadId: id },
        { taskId: id },
      ],
    } as FilterQuery<T>;
  }

  /**
   * Find documents scoped strictly to organizationId
   */
  async findMany(
    organizationId: string,
    filter: FilterQuery<T> = {},
    options?: QueryOptions
  ): Promise<T[]> {
    const tenantFilter = { ...filter, organizationId } as FilterQuery<T>;
    return this.model.find(tenantFilter, null, options).lean() as unknown as Promise<T[]>;
  }

  /**
   * Find paginated documents scoped strictly to organizationId
   */
  async findPaginated(
    organizationId: string,
    filter: FilterQuery<T> = {},
    options: PaginationOptions = {}
  ): Promise<PaginatedResult<T>> {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 25));
    const skip = (page - 1) * limit;
    const sort = options.sort || { createdAt: -1 };

    const tenantFilter = { ...filter, organizationId } as FilterQuery<T>;

    const [total, docs] = await Promise.all([
      this.model.countDocuments(tenantFilter),
      this.model
        .find(tenantFilter)
        .sort(sort as never)
        .skip(skip)
        .limit(limit)
        .populate(options.populate as never)
        .lean() as unknown as Promise<T[]>,
    ]);

    return {
      docs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find a single document by ID within tenant boundary
   */
  async findById(
    organizationId: string,
    id: string,
    populate?: string | PopulateOptions | (string | PopulateOptions)[]
  ): Promise<T | null> {
    const query = this.model.findOne(this.buildIdFilter(organizationId, id));
    if (populate) {
      query.populate(populate as never);
    }
    return query.lean() as unknown as Promise<T | null>;
  }

  /**
   * Find one document matching criteria within tenant boundary
   */
  async findOne(
    organizationId: string,
    filter: FilterQuery<T>,
    populate?: string | PopulateOptions | (string | PopulateOptions)[]
  ): Promise<T | null> {
    const tenantFilter = { ...filter, organizationId } as FilterQuery<T>;
    const query = this.model.findOne(tenantFilter);
    if (populate) {
      query.populate(populate as never);
    }
    return query.lean() as unknown as Promise<T | null>;
  }

  /**
   * Create a new document with forced organizationId injection
   */
  async create(organizationId: string, data: Partial<T>): Promise<T> {
    const docData = { ...data, organizationId };
    const created = await this.model.create(docData);
    return created.toObject() as unknown as T;
  }

  async createMany(organizationId: string, items: Partial<T>[]): Promise<T[]> {
    const docs = items.map((item) => ({ ...item, organizationId }));
    const created = await this.model.insertMany(docs);
    return created.map((doc) => {
      const d = doc as unknown as { toObject?: () => unknown };
      return typeof d.toObject === 'function' ? d.toObject() : doc;
    }) as unknown as T[];
  }

  /**
   * Update document by ID within tenant boundary
   */
  async updateById(
    organizationId: string,
    id: string,
    updateData: UpdateQuery<T>,
    options: QueryOptions = { new: true }
  ): Promise<T | null> {
    return this.model
      .findOneAndUpdate(this.buildIdFilter(organizationId, id), updateData, {
        ...options,
        new: true,
      })
      .lean() as unknown as Promise<T | null>;
  }

  /**
   * Update document matching filter within tenant boundary
   */
  async updateOne(
    organizationId: string,
    filter: FilterQuery<T>,
    updateData: UpdateQuery<T>,
    options: QueryOptions = { new: true }
  ): Promise<T | null> {
    const tenantFilter = { ...filter, organizationId } as FilterQuery<T>;
    return this.model
      .findOneAndUpdate(tenantFilter, updateData, { ...options, new: true })
      .lean() as unknown as Promise<T | null>;
  }

  /**
   * Delete document by ID within tenant boundary
   */
  async deleteById(organizationId: string, id: string): Promise<boolean> {
    const result = await this.model.deleteOne(this.buildIdFilter(organizationId, id));
    return result.deletedCount === 1;
  }

  /**
   * Count documents matching filter within tenant boundary
   */
  async count(organizationId: string, filter: FilterQuery<T> = {}): Promise<number> {
    const tenantFilter = { ...filter, organizationId } as FilterQuery<T>;
    return this.model.countDocuments(tenantFilter);
  }

  /**
   * Check existence of document matching filter within tenant boundary
   */
  async exists(organizationId: string, filter: FilterQuery<T>): Promise<boolean> {
    const tenantFilter = { ...filter, organizationId } as FilterQuery<T>;
    const count = await this.model.countDocuments(tenantFilter).limit(1);
    return count > 0;
  }
}
