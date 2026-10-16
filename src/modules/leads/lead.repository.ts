import { BaseTenantRepository } from '../../shared/repository/BaseTenantRepository.js';
import { ILead, LeadModel } from './lead.model.js';

export class LeadRepository extends BaseTenantRepository<ILead> {
  constructor() {
    super(LeadModel);
  }

  /**
   * Find duplicate lead by normalized phone or normalized email within the organization
   */
  async findDuplicate(
    organizationId: string,
    normalizedPhone: string,
    normalizedEmail?: string
  ): Promise<ILead | null> {
    const conditions: Array<Record<string, unknown>> = [{ normalizedPhone }];

    if (normalizedEmail) {
      conditions.push({ normalizedEmail });
    }

    return this.model
      .findOne({
        organizationId,
        $or: conditions,
      })
      .lean() as unknown as Promise<ILead | null>;
  }

  /**
   * Get next auto-incrementing human-readable leadId (e.g. LD-10025)
   */
  async generateLeadId(organizationId: string): Promise<string> {
    const lastLead = await this.model
      .findOne({ organizationId })
      .sort({ createdAt: -1 })
      .select('leadId')
      .lean();

    if (lastLead && (lastLead as any).leadId) {
      const match = String((lastLead as any).leadId).match(/^LD-(\d+)$/);
      if (match) {
        return `LD-${parseInt(match[1], 10) + 1}`;
      }
    }

    const count = await this.model.countDocuments({ organizationId });
    return `LD-${10001 + count}`;
  }

  /**
   * Aggregate lead counts by status for pipeline summaries
   */
  async getStatusMetrics(organizationId: string): Promise<Record<string, number>> {
    const results = await this.model.aggregate([
      { $match: { organizationId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const metrics: Record<string, number> = {};
    results.forEach((item) => {
      metrics[item._id] = item.count;
    });

    return metrics;
  }
}

export const leadRepository = new LeadRepository();
