import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { DockerModule } from 'src/docker/docker.module';
import { EventsGateway } from './events.gateway';
import { SocketReservationService } from './socket-reservation.service';
import { SystemMetricsService } from './system-metrics.service';

@Module({
  imports: [AuthModule, DockerModule],
  providers: [SocketReservationService, SystemMetricsService, EventsGateway],
})
export class GatewayModule {}
